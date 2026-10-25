"""Private administrator password, login attempts and short-lived sessions.

Revision ID: 0002
Revises: 0001
"""
from alembic import op

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('''CREATE TABLE admin_credentials (
        id SMALLINT PRIMARY KEY CHECK(id=1),
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )''')
    op.execute('''CREATE TABLE admin_login_limiter (
        id SMALLINT PRIMARY KEY CHECK(id=1),
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_until TIMESTAMPTZ
    )''')
    op.execute('INSERT INTO admin_login_limiter(id) VALUES (1)')
    op.execute('''CREATE TABLE admin_sessions (
        token_digest BYTEA PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
    )''')
    op.execute('CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at)')


def downgrade():
    op.execute('DROP TABLE IF EXISTS admin_sessions,admin_login_limiter,admin_credentials')
