"""MDB58 private-beta ingestion API. No original exports, executables or arbitrary files accepted."""
import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import socket
import struct
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from psycopg.types.json import Jsonb
from .db import connect
from .models import ActivateRequest, StartRequest, ChunkRequest, Contribution
from .canonical import content_digest

API = '/mdb58/api/v1'
SESSION_COOKIE = 'mdb58_session'
MAX_CHUNK = 128 * 1024
MAX_TOTAL = 24 * 1024 * 1024
app = FastAPI(title='MDB58 private-beta ingestion', docs_url=None, redoc_url=None, openapi_url=None)


def digest(value: str) -> bytes:
    return hashlib.sha256(value.encode('utf-8')).digest()


def invite_digest(value: str) -> bytes:
    return hmac.new(os.environ['MDB58_INVITE_PEPPER'].encode(), value.encode(), hashlib.sha256).digest()


def utcnow():
    return datetime.now(timezone.utc)


def invalid(message='Request rejected', status=400):
    raise HTTPException(status_code=status, detail=message)


@app.middleware('http')
async def inbound_guard(request: Request, call_next):
    if request.url.path.startswith(API):
        if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            origin = request.headers.get('origin')
            if origin != os.environ.get('MDB58_ALLOWED_ORIGIN'):
                return JSONResponse({'detail': 'Origin not permitted'}, status_code=403)
            if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json' and request.method != 'DELETE':
                return JSONResponse({'detail': 'JSON only'}, status_code=415)
            try: length=int(request.headers.get('content-length', '0') or '0')
            except ValueError: return JSONResponse({'detail':'Bad content length'},status_code=400)
            if length > 800000: return JSONResponse({'detail': 'Request too large'}, status_code=413)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def session(request: Request, csrf=False):
    token = request.cookies.get(SESSION_COOKIE, '')
    if len(token) != 64: invalid('Invite required', 401)
    with connect() as db:
        row = db.execute('''SELECT a.contributor_id, a.csrf_digest, a.expires_at FROM auth_sessions a
            JOIN contributors c ON c.id=a.contributor_id WHERE a.token_digest=%s AND c.deleted_at IS NULL''', (digest(token),)).fetchone()
    if not row or row['expires_at'] <= utcnow(): invalid('Invite required', 401)
    if csrf:
        provided = request.headers.get('x-mdb58-csrf', '')
        if not provided or not hmac.compare_digest(digest(provided), row['csrf_digest']): invalid('Invalid CSRF token', 403)
    return row['contributor_id']


def contributor(request: Request):
    return session(request, csrf=True)


@app.get(API + '/health')
def health():
    return {'status': 'ok', 'schema_version': '1.0'}


@app.post(API + '/beta/activate')
def activate(data: ActivateRequest, response: Response):
    with connect() as db:
        with db.transaction():
            row = db.execute('''SELECT * FROM invitations WHERE token_digest=%s FOR UPDATE''', (invite_digest(data.invite),)).fetchone()
            if not row or row['revoked'] or row['redeemed_at'] or row['expires_at'] <= utcnow():
                invalid('Invalid, expired or already redeemed invitation', 403)
            c = db.execute('INSERT INTO contributors(consent_version) VALUES (%s) RETURNING id', ('not-consented',)).fetchone()['id']
            token, csrf = secrets.token_hex(32), secrets.token_hex(32)
            db.execute('''INSERT INTO auth_sessions (contributor_id,token_digest,csrf_digest,expires_at)
              VALUES (%s,%s,%s,%s)''', (c,digest(token),digest(csrf),utcnow() + timedelta(days=365)))
            db.execute('UPDATE invitations SET redeemed_by=%s, redeemed_at=now() WHERE id=%s', (c,row['id']))
    response.set_cookie(SESSION_COOKIE, token, secure=True, httponly=True, samesite='strict', max_age=365*86400, path='/mdb58/api')
    return {'activated': True, 'csrf': csrf, 'contributed': False}


@app.get(API + '/me')
def me(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE, '')
    if len(token) != 64: return {'activated': False, 'contributed': False}
    with connect() as db:
        row = db.execute('''SELECT a.contributor_id,c.consent_version FROM auth_sessions a
           JOIN contributors c ON c.id=a.contributor_id WHERE a.token_digest=%s AND a.expires_at>now() AND c.deleted_at IS NULL''', (digest(token),)).fetchone()
        if not row: return {'activated': False, 'contributed': False}
        active = db.execute('''SELECT cs.source, cs.submission_id,
                  s.archive_sha256 AS archive_sha256, cs.content_sha256
           FROM contribution_snapshots cs JOIN submissions s ON s.id=cs.submission_id
           WHERE cs.contributor_id=%s AND cs.active''', (row['contributor_id'],)).fetchall()
        # CSRF is deliberately NOT returned; held only in current tab after activate.
        # On reload rotate session CSRF using a new token delivered to current session.
        csrf = secrets.token_hex(32)
        db.execute('UPDATE auth_sessions SET csrf_digest=%s, expires_at=%s WHERE token_digest=%s',
                   (digest(csrf),utcnow()+timedelta(days=365),digest(token)))
        response.set_cookie(SESSION_COOKIE,token,secure=True,httponly=True,samesite='strict',max_age=365*86400,path='/mdb58/api')
        db.commit()
        return {'activated': True, 'csrf': csrf, 'contributed': bool(active), 'contributions': active}


@app.post(API + '/contributions/check')
def check_archive(data: dict, owner: Annotated[int, Depends(contributor)]):
    archive = data.get('archive_sha256', '')
    if not isinstance(archive,str) or len(archive) != 64 or any(ch not in '0123456789abcdef' for ch in archive): invalid('Invalid hash')
    with connect() as db:
        row = db.execute('''SELECT 1 FROM contribution_snapshots cs JOIN submissions s ON s.id=cs.submission_id
          WHERE cs.contributor_id=%s AND cs.active AND cs.source='spotify_extended_history' AND s.archive_sha256=%s''', (owner,archive)).fetchone()
    return {'identical_active_archive': bool(row)}


@app.post(API + '/contributions')
def start(data: StartRequest, owner: Annotated[int, Depends(contributor)]):
    try: sid = uuid.UUID(data.id)
    except ValueError: invalid('Bad submission ID')
    with connect() as db:
        with db.transaction():
            existing = db.execute('SELECT contributor_id, total_chunks, state, source, archive_sha256 FROM submissions WHERE id=%s', (sid,)).fetchone()
            if existing:
                if existing['contributor_id'] != owner or existing['total_chunks'] != data.total_chunks or existing['source'] != data.source or existing['archive_sha256'] != data.archive_sha256: invalid('Submission conflict', 409)
                return {'id': str(sid), 'state': existing['state']}
            in_progress = db.execute("SELECT count(*) AS n FROM submissions WHERE contributor_id=%s AND state='staging'",(owner,)).fetchone()['n']
            if in_progress >= 3: invalid('Too many staged submissions; try again later',429)
            db.execute('''INSERT INTO submissions(id,contributor_id,source,archive_sha256,total_chunks)
               VALUES (%s,%s,%s,%s,%s)''', (sid,owner,data.source,data.archive_sha256,data.total_chunks))
    return {'id': str(sid), 'state': 'staging'}


@app.put(API + '/contributions/{sid}/chunks/{index}')
def chunk(sid: uuid.UUID, index: int, data: ChunkRequest, owner: Annotated[int, Depends(contributor)]):
    if index != data.index: invalid('Chunk index conflict')
    try: blob = base64.b64decode(data.base64_data, validate=True)
    except (ValueError, binascii.Error): invalid('Invalid chunk encoding')
    if not blob or len(blob) > MAX_CHUNK: invalid('Chunk size exceeded', 413)
    if hashlib.sha256(blob).hexdigest() != data.sha256: invalid('Chunk checksum mismatch')
    with connect() as db:
        with db.transaction():
            sub = db.execute('SELECT * FROM submissions WHERE id=%s FOR UPDATE', (sid,)).fetchone()
            if not sub or sub['contributor_id'] != owner: invalid('Unknown submission', 404)
            if sub['state'] != 'staging': invalid('Submission already finalised', 409)
            if index >= sub['total_chunks']: invalid('Invalid chunk index')
            row = db.execute('SELECT sha256 FROM submission_chunks WHERE submission_id=%s AND chunk_index=%s', (sid,index)).fetchone()
            if row:
                if row['sha256'] != data.sha256: invalid('Chunk already exists with different contents', 409)
            else:
                db.execute('INSERT INTO submission_chunks VALUES (%s,%s,%s,%s)', (sid,index,blob,data.sha256))
    return {'accepted': True, 'index': index}


def scan_clamav(blob: bytes):
    if os.environ.get('MDB58_CLAMAV_REQUIRED','false').lower() != 'true': return
    # Fail closed. JSON is inert data, this is defence in depth for an enabled scanner.
    with socket.create_connection((os.environ.get('MDB58_CLAMAV_HOST','clamav'),3310), timeout=20) as sock:
        sock.settimeout(60)
        sock.sendall(b'zINSTREAM\0')
        for i in range(0,len(blob),65536):
            part=blob[i:i+65536]
            sock.sendall(struct.pack('!I',len(part)) + part)
        sock.sendall(struct.pack('!I',0))
        reply=sock.recv(4096)
    if b'OK' not in reply or b'FOUND' in reply: invalid('Content scan unsuccessful',422)


def resolve_track(db, track):
    # Per-identifier advisory locks prevent race-driven duplicate catalogue rows.
    provider = [i for i in track.identifiers if i.namespace != 'musicbrainz.recording']
    recording_ids = [i for i in track.identifiers if i.namespace == 'musicbrainz.recording']
    for ident in sorted(track.identifiers, key=lambda x:(x.namespace,x.value)):
        db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', (ident.namespace + ':' + ident.value,))
    found=set()
    for ident in provider:
        row=db.execute('SELECT source_track_id FROM external_identifiers WHERE namespace=%s AND external_id=%s', (ident.namespace,ident.value)).fetchone()
        if row: found.add(row['source_track_id'])
    if len(found)>1: invalid('Conflicting source identities; requires manual review',422)
    if found:
        tid=next(iter(found))
        known_rec=db.execute('SELECT recording_id FROM source_tracks WHERE id=%s',(tid,)).fetchone()['recording_id']
        for ident in recording_ids:
            mapped=db.execute('SELECT recording_id FROM recording_identifiers WHERE namespace=%s AND external_id=%s',
                              (ident.namespace,ident.value)).fetchone()
            if mapped and mapped['recording_id']!=known_rec:
                # Conflicting evidence is recorded but never silently merged.
                db.execute('INSERT INTO recording_links(source_track_id,target_recording_id,method,active) VALUES (%s,%s,%s,false)',
                           (tid,mapped['recording_id'],'conflict:submitted_musicbrainz_id'))
            elif not mapped:
                db.execute('INSERT INTO recording_identifiers(recording_id,namespace,external_id) VALUES (%s,%s,%s)',
                           (known_rec,ident.namespace,ident.value))
        for ident in provider:
            db.execute('INSERT INTO external_identifiers(source_track_id,namespace,external_id) VALUES (%s,%s,%s) ON CONFLICT(namespace,external_id) DO NOTHING', (tid,ident.namespace,ident.value))
        return tid
    canonical=set()
    for ident in recording_ids:
        row=db.execute('SELECT recording_id FROM recording_identifiers WHERE namespace=%s AND external_id=%s',(ident.namespace,ident.value)).fetchone()
        if row: canonical.add(row['recording_id'])
    if len(canonical)>1: invalid('Conflicting recording identities',422)
    rec=next(iter(canonical)) if canonical else db.execute('INSERT INTO recordings DEFAULT VALUES RETURNING id').fetchone()['id']
    tid=db.execute('INSERT INTO source_tracks(recording_id,title,primary_artist,album) VALUES (%s,%s,%s,%s) RETURNING id',
                   (rec,track.title,track.artists[0],track.album)).fetchone()['id']
    for i,artist in enumerate(track.artists):
        db.execute('INSERT INTO artist_credits VALUES (%s,%s,%s)',(tid,i,artist))
    for ident in provider:
        db.execute('INSERT INTO external_identifiers(source_track_id,namespace,external_id) VALUES (%s,%s,%s)',(tid,ident.namespace,ident.value))
    for ident in recording_ids:
        db.execute('INSERT INTO recording_identifiers(recording_id,namespace,external_id) VALUES (%s,%s,%s) ON CONFLICT(namespace,external_id) DO NOTHING',(rec,ident.namespace,ident.value))
    return tid


@app.post(API + '/contributions/{sid}/commit')
def commit(sid: uuid.UUID, owner: Annotated[int, Depends(contributor)]):
    with connect() as db:
        with db.transaction():
            # Per-contributor row lock prevents concurrent replacements and catalogues being counted twice.
            db.execute('SELECT id FROM contributors WHERE id=%s FOR UPDATE', (owner,))
            sub=db.execute('SELECT * FROM submissions WHERE id=%s FOR UPDATE', (sid,)).fetchone()
            if not sub or sub['contributor_id'] != owner: invalid('Unknown submission',404)
            if sub['state'] == 'committed': return {'status':'committed','id':str(sid),'identical':False}
            if sub['state'] == 'duplicate': return {'status':'duplicate','id':str(sid),'identical':True}
            if sub['state'] != 'staging': invalid('Submission not available',409)
            chunks=db.execute('SELECT chunk_index, content FROM submission_chunks WHERE submission_id=%s ORDER BY chunk_index', (sid,)).fetchall()
            if len(chunks)!=sub['total_chunks'] or [x['chunk_index'] for x in chunks]!=list(range(sub['total_chunks'])):
                invalid('Incomplete upload',409)
            raw=b''.join(bytes(x['content']) for x in chunks)
            if len(raw)>MAX_TOTAL: invalid('Submission too large',413)
            scan_clamav(raw)
            try: payload=Contribution.model_validate_json(raw)
            except ValidationError: invalid('Invalid contribution payload',422)
            if payload.submission.id != str(sid) or payload.submission.archive_sha256!=sub['archive_sha256'] or payload.source!=sub['source']:
                invalid('Submission metadata mismatch',422)
            content_hash=content_digest(payload)
            current=db.execute('''SELECT id,content_sha256 FROM contribution_snapshots WHERE contributor_id=%s AND source=%s AND active''', (owner,payload.source)).fetchone()
            if current and current['content_sha256']==content_hash:
                db.execute("UPDATE submissions SET state='duplicate', content_sha256=%s,updated_at=now() WHERE id=%s",(content_hash,sid))
                db.execute('DELETE FROM submission_chunks WHERE submission_id=%s',(sid,))
                return {'status':'duplicate','id':str(sid),'identical':True}
            # Safe for regenerated full exports: don't replace a longer history with shorter data.
            if current:
                old=db.execute('SELECT first_week,last_week FROM contribution_snapshots WHERE id=%s',(current['id'],)).fetchone()
                if payload.submission.first_week > old['first_week'] or payload.submission.last_week < old['last_week']:
                    invalid('Snapshot has reduced coverage; keep existing contribution',409)
            # Resolve exact source identities, never fuzzy-merge records or trust artist/title for identity.
            references={t.ref:resolve_track(db,t) for t in payload.tracks}
            new_id=db.execute('''INSERT INTO contribution_snapshots
              (contributor_id,source,submission_id,content_sha256,aggregation_version,first_week,last_week)
              VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id''',
              (owner,payload.source,sid,content_hash,payload.aggregation_version,payload.submission.first_week,payload.submission.last_week)).fetchone()['id']
            for t in payload.weekly_tracks:
                db.execute('''INSERT INTO weekly_track_stats VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                  (new_id,references[t.track_ref],t.week_start,t.events,t.duration_known,t.qualifying_plays,t.played_ms,t.skip_known,t.skips,
                   t.shuffle_known,t.shuffled,t.immediate_repeats,t.time_known,t.utc_hour_buckets,t.weekday_events,t.weekend_events))
            for s in payload.weekly_sessions:
                db.execute('INSERT INTO weekly_session_stats VALUES (%s,%s,%s,%s,%s)',
                           (new_id,s.week_start,s.session_count,s.session_duration_ms,s.active_days))
            # Old aggregate snapshots and their submissions are removed after the new snapshot is durable.
            if current:
                db.execute('UPDATE contribution_snapshots SET active=false WHERE id=%s',(current['id'],))
            db.execute('UPDATE contribution_snapshots SET active=true WHERE id=%s',(new_id,))
            db.execute("UPDATE contributors SET consent_version='mdb58-2026-10-v1' WHERE id=%s",(owner,))
            db.execute("UPDATE submissions SET state='committed',content_sha256=%s,updated_at=now() WHERE id=%s",(content_hash,sid))
            db.execute('DELETE FROM submission_chunks WHERE submission_id=%s',(sid,))
            if current:
                old_submission=db.execute('SELECT submission_id FROM contribution_snapshots WHERE id=%s',(current['id'],)).fetchone()['submission_id']
                db.execute('DELETE FROM contribution_snapshots WHERE id=%s',(current['id'],))
                db.execute('DELETE FROM submissions WHERE id=%s',(old_submission,))
    return {'status':'committed','id':str(sid),'identical':False}


@app.delete(API + '/me/contributions')
def remove(request: Request, response: Response, owner: Annotated[int, Depends(contributor)]):
    with connect() as db:
        with db.transaction():
            db.execute('SELECT id FROM contributors WHERE id=%s FOR UPDATE',(owner,))
            db.execute('DELETE FROM contribution_snapshots WHERE contributor_id=%s',(owner,))
            db.execute('DELETE FROM submissions WHERE contributor_id=%s',(owner,))
            db.execute('DELETE FROM auth_sessions WHERE contributor_id=%s',(owner,))
            db.execute('UPDATE invitations SET redeemed_by=NULL, revoked=true WHERE redeemed_by=%s',(owner,))
            db.execute('DELETE FROM contributors WHERE id=%s',(owner,))
    response.delete_cookie(SESSION_COOKIE,path='/mdb58/api',secure=True,httponly=True,samesite='strict')
    return {'removed': True, 'models_require_rebuild': True}


class RequestSizeLimit:
    """Bound streaming HTTP bodies before FastAPI parses them."""
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('method') not in ('POST','PUT','PATCH'):
            return await self.app(scope,receive,send)
        blocks=[];total=0
        while True:
            msg=await receive()
            if msg['type']=='http.disconnect': return
            if msg['type']!='http.request': continue
            piece=msg.get('body',b'');total+=len(piece)
            if total>800000:
                response=JSONResponse({'detail':'Request too large'},status_code=413)
                return await response(scope,receive,send)
            blocks.append(piece)
            if not msg.get('more_body',False):break
        passed=False
        async def replay():
            nonlocal passed
            if not passed:
                passed=True
                return {'type':'http.request','body':b''.join(blocks),'more_body':False}
            return await receive()
        return await self.app(scope,replay,send)

app.add_middleware(RequestSizeLimit)
