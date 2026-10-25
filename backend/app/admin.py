"""Password-only MDB58 administration UI.

Admin credentials and ephemeral bearer sessions are deliberately isolated from
invited contributors. No admin credentials, hashes, sessions or listening data
are exposed to the dashboard until login. The UI stores tokens in JS memory only.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import hashlib
import hmac
import os
import secrets

from argon2 import PasswordHasher, Type
from argon2.exceptions import VerificationError, VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field, field_validator

from .db import connect

BASE = '/mdb58/admin'
ASSETS = Path(__file__).resolve().parent / 'admin_assets'
router = APIRouter(prefix=BASE, tags=['admin'])
_hasher = PasswordHasher(
    time_cost=3, memory_cost=65536, parallelism=2, hash_len=32,
    salt_len=16, type=Type.ID
)
TOKEN_LIFETIME = timedelta(minutes=30)
LOGIN_WINDOW = timedelta(minutes=10)
LOCK_DURATION = timedelta(seconds=90)
MAX_FAILURES = 8


def now():
    return datetime.now(timezone.utc)


def secret_hash(token):
    return hashlib.sha256(token.encode('utf-8')).digest()


def error(status, message):
    raise HTTPException(status_code=status, detail=message)


def guard_mutation(request: Request):
    # Origin is checked for every admin mutation, including first-time setup.
    if request.headers.get('origin') != os.environ.get('MDB58_ALLOWED_ORIGIN'):
        error(403, 'Origin not permitted')
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        error(415, 'JSON only')


class PasswordSetup(BaseModel):
    setup_key: str = Field(min_length=32, max_length=256)
    password: str = Field(min_length=14, max_length=256)


class PasswordLogin(BaseModel):
    password: str = Field(min_length=1, max_length=256)


@router.get('', response_class=HTMLResponse, include_in_schema=False)
@router.get('/', response_class=HTMLResponse, include_in_schema=False)
def index():
    # Only the login/setup shell is served here; no private DB values embedded.
    return HTMLResponse((ASSETS / 'index.html').read_text(encoding='utf-8'), headers={
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })


@router.get('/api/status')
def status():
    # The only unauthenticated DB read; never disclose dashboard statistics.
    with connect() as db:
        configured = db.execute('SELECT EXISTS(SELECT 1 FROM admin_credentials) AS value').fetchone()['value']
    return {'configured': configured}


@router.post('/api/setup', dependencies=[Depends(guard_mutation)])
def setup(data: PasswordSetup):
    expected = os.environ.get('MDB58_ADMIN_SETUP_TOKEN', '')
    if len(expected) < 32:
        error(503, 'Admin setup key is not configured')
    if not hmac.compare_digest(secret_hash(data.setup_key), secret_hash(expected)):
        error(403, 'Invalid setup key')
    with connect() as db:
        with db.transaction():
            # Only one setup may succeed, even if concurrent clients submit.
            db.execute('SELECT pg_advisory_xact_lock(580058)')
            if db.execute('SELECT 1 FROM admin_credentials').fetchone():
                error(409, 'Administrator already configured')
            password_hash = _hasher.hash(data.password)
            db.execute('INSERT INTO admin_credentials(id,password_hash) VALUES (1,%s)', (password_hash,))
    return {'configured': True, 'message': 'Password created. Sign in to view the dashboard.'}


@router.post('/api/login', dependencies=[Depends(guard_mutation)])
def login(data: PasswordLogin):
    with connect() as db:
        with db.transaction():
            limit = db.execute('SELECT * FROM admin_login_limiter WHERE id=1 FOR UPDATE').fetchone()
            instant = now()
            if limit['locked_until'] and limit['locked_until'] > instant:
                error(429, 'Too many attempts. Try again shortly.')
            cred = db.execute('SELECT password_hash FROM admin_credentials WHERE id=1').fetchone()
            if not cred:
                error(409, 'Set up the admin password first')
            valid = False
            try:
                valid = _hasher.verify(cred['password_hash'], data.password)
            except (VerifyMismatchError, VerificationError):
                valid = False
            if not valid:
                active_window = instant - limit['window_start'] <= LOGIN_WINDOW
                attempts = limit['failed_attempts'] + 1 if active_window else 1
                locked = instant + LOCK_DURATION if attempts >= MAX_FAILURES else None
                db.execute('''UPDATE admin_login_limiter SET failed_attempts=%s,
                    window_start=%s, locked_until=%s WHERE id=1''',
                    (attempts, limit['window_start'] if active_window else instant, locked))
                # Don't raise inside transaction, or the failed-attempt update rolls back.
                incorrect = True
            else:
                incorrect = False
                db.execute('''UPDATE admin_login_limiter SET failed_attempts=0,
                    window_start=%s, locked_until=NULL WHERE id=1''', (instant,))
                if _hasher.check_needs_rehash(cred['password_hash']):
                    db.execute('UPDATE admin_credentials SET password_hash=%s, updated_at=now() WHERE id=1',
                               (_hasher.hash(data.password),))
                token = secrets.token_hex(32)
                db.execute('DELETE FROM admin_sessions WHERE expires_at <= %s', (instant,))
                db.execute('INSERT INTO admin_sessions(token_digest, expires_at) VALUES (%s,%s)',
                           (secret_hash(token), instant + TOKEN_LIFETIME))
    if incorrect:
        error(401, 'Incorrect password')
    return {'token': token, 'expires_in': int(TOKEN_LIFETIME.total_seconds())}


def require_admin(request: Request):
    value = request.headers.get('authorization', '')
    if not value.startswith('Bearer '):
        error(401, 'Admin login required')
    token = value[7:]
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        error(401, 'Admin login required')
    with connect() as db:
        row = db.execute('SELECT 1 FROM admin_sessions WHERE token_digest=%s AND expires_at>now()',
                         (secret_hash(token),)).fetchone()
    if not row:
        error(401, 'Admin session expired')
    return token


@router.post('/api/logout', dependencies=[Depends(guard_mutation)])
def logout(token: str = Depends(require_admin)):
    with connect() as db:
        db.execute('DELETE FROM admin_sessions WHERE token_digest=%s', (secret_hash(token),))
        db.commit()
    return {'logged_out': True}


def _iso(value):
    return value.isoformat() if value else None


@router.get('/api/overview')
def overview(_token: str = Depends(require_admin)):
    # All displayed aggregates use only ACTIVE contribution snapshots. No user
    # credentials, IPs, pseudonymous listener IDs or histories are returned.
    with connect() as db:
        counts = db.execute('''
            SELECT
              (SELECT COUNT(*) FROM contributors) AS activated,
              (SELECT COUNT(DISTINCT contributor_id) FROM contribution_snapshots WHERE active) AS active_contributors,
              (SELECT COUNT(*) FROM contribution_snapshots WHERE active) AS active_snapshots,
              (SELECT COUNT(*) FROM source_tracks) AS catalog_tracks,
              (SELECT COUNT(*) FROM recordings) AS recordings,
              (SELECT pg_database_size(current_database())) AS database_bytes
        ''').fetchone()
        plays = db.execute('''
            SELECT COUNT(*) AS weekly_rows,
                   COUNT(DISTINCT w.source_track_id) AS distinct_tracks,
                   COALESCE(SUM(w.events),0) AS listening_events,
                   COALESCE(SUM(w.qualifying_plays),0) AS qualifying_plays,
                   COALESCE(SUM(w.played_ms),0) AS listened_ms,
                   COALESCE(SUM(w.skips),0) AS skips,
                   COALESCE(SUM(w.skip_known),0) AS skip_known
            FROM weekly_track_stats w
            JOIN contribution_snapshots cs ON cs.id=w.snapshot_id
            WHERE cs.active
        ''').fetchone()
        states = db.execute('''SELECT state,COUNT(*) AS number FROM submissions
                               GROUP BY state ORDER BY state''').fetchall()
        sources = db.execute('''SELECT source,COUNT(*) AS number FROM contribution_snapshots
                                WHERE active GROUP BY source ORDER BY number DESC''').fetchall()
        recent = db.execute('''SELECT s.state, s.source, s.created_at, s.updated_at,
                                    COALESCE(cs.active,false) AS active
                             FROM submissions s LEFT JOIN contribution_snapshots cs
                             ON cs.submission_id=s.id
                             ORDER BY s.created_at DESC LIMIT 12''').fetchall()
        weeks = db.execute('''SELECT w.week_start,
                                   SUM(w.events) AS listening_events,
                                   COALESCE(SUM(w.qualifying_plays),0) AS qualifying_plays
                            FROM weekly_track_stats w
                            JOIN contribution_snapshots cs ON cs.id=w.snapshot_id AND cs.active
                            GROUP BY w.week_start ORDER BY w.week_start DESC LIMIT 12''').fetchall()
        version = db.execute('SELECT version_num FROM alembic_version LIMIT 1').fetchone()
    return {
        'generated_at': _iso(now()),
        'schema_version': version['version_num'] if version else 'unknown',
        'totals': {k:int(v) for k,v in counts.items()},
        'listening': {k:int(v) for k,v in plays.items()},
        'submission_states': [{ 'state':r['state'], 'count':int(r['number']) } for r in states],
        'sources': [{ 'source':r['source'], 'count':int(r['number']) } for r in sources],
        'recent': [{ 'state':r['state'], 'source':r['source'], 'created_at':_iso(r['created_at']),
                     'updated_at':_iso(r['updated_at']), 'active':r['active'] } for r in recent],
        'weeks': [{ 'week':r['week_start'].isoformat(), 'listening_events':int(r['listening_events']),
                    'qualifying_plays':int(r['qualifying_plays']) } for r in reversed(weeks)],
    }
