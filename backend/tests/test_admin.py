"""Admin security invariants. These tests require no running PostgreSQL instance."""
from pathlib import Path
import hashlib
import hmac
import re

from argon2.exceptions import VerifyMismatchError
from app.admin import ASSETS, _hasher, secret_hash, PasswordSetup
from pydantic import ValidationError


def test_argon2id_has_random_salt_and_never_stores_plaintext():
    password = 'a-very-long-correct-horse-battery-staple'
    first = _hasher.hash(password)
    second = _hasher.hash(password)
    assert first.startswith('$argon2id$')
    assert second.startswith('$argon2id$')
    assert first != second  # independently generated random salts
    assert password not in first
    assert _hasher.verify(first, password)
    try:
        _hasher.verify(first, 'incorrect-password')
    except VerifyMismatchError:
        pass
    else:
        raise AssertionError('Incorrect password unexpectedly verified')


def test_admin_requires_strong_first_run_password():
    try:
        PasswordSetup(setup_key='x' * 64, password='short')
    except ValidationError:
        pass
    else:
        raise AssertionError('Short password accepted')
    PasswordSetup(setup_key='a' * 64, password='correct-horse-battery-staple')


def test_admin_token_storage_is_one_way():
    token = 'a' * 64
    assert secret_hash(token) == hashlib.sha256(token.encode()).digest()
    assert hmac.compare_digest(secret_hash(token), secret_hash(token))
    assert not hmac.compare_digest(secret_hash(token), secret_hash('b' * 64))


def test_dashboard_is_not_prefilled_with_data_or_saved_tokens():
    html = (ASSETS / 'index.html').read_text()
    script = (ASSETS / 'admin.js').read_text()
    assert 'auth-screen' in html and 'dashboard' in html
    assert 'class="app-shell hidden"' in html
    assert 'localStorage' not in script and 'sessionStorage' not in script
    assert "request('/status')" in script
    assert 'Bearer ${accessToken}' in script
    assert "replaceChildren" in script  # textContent: not HTML injection
    assert not re.search(r'innerHTML\s*=', script)


def test_admin_routes_reject_anonymous_overview_and_wrong_bootstrap(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.admin import router
    monkeypatch.setenv('MDB58_ALLOWED_ORIGIN', 'https://example.test:6967')
    monkeypatch.setenv('MDB58_ADMIN_SETUP_TOKEN', 'a' * 64)
    mini = FastAPI()
    mini.include_router(router)
    client = TestClient(mini)
    assert client.get('/mdb58/admin/api/overview').status_code == 401
    html = client.get('/mdb58/admin')
    assert html.status_code == 200
    assert 'no-store' in html.headers['cache-control']
    assert 'frame-ancestors' in html.headers['content-security-policy']
    assert client.post('/mdb58/admin/api/setup', json={
        'setup_key': 'b' * 64,
        'password': 'correct-horse-battery-staple'
    }, headers={'Origin':'https://example.test:6967'}).status_code == 403
    assert client.post('/mdb58/admin/api/login', json={
        'password':'correct-horse-battery-staple'
    }, headers={'Origin':'https://attacker.example'}).status_code == 403
