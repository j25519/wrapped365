"""Console-only recovery for the MDB58 admin password.

Requires direct host/Docker access. No reset or recovery endpoint is exposed
via HTTP and no email/identity data is collected.
"""
import getpass
import sys
from .db import connect
from .admin import _hasher


def main():
    if sys.argv[1:] != ['reset']:
        print('Usage: python -m app.admin_cli reset', file=sys.stderr)
        return 2
    first = getpass.getpass('New admin password (at least 14 characters): ')
    second = getpass.getpass('Confirm password: ')
    if len(first) < 14 or len(first) > 256 or first != second:
        print('Passwords must match and contain 14–256 characters.', file=sys.stderr)
        return 2
    new_hash = _hasher.hash(first)
    with connect() as db:
        with db.transaction():
            result = db.execute('UPDATE admin_credentials SET password_hash=%s, updated_at=now() WHERE id=1 RETURNING id', (new_hash,)).fetchone()
            if not result:
                print('Admin not yet initialised; use the first-run dashboard setup.', file=sys.stderr)
                return 1
            db.execute('DELETE FROM admin_sessions')
    print('Admin password changed. Existing admin sessions have been revoked.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
