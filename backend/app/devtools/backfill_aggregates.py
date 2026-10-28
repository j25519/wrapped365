"""Idempotent one-time population of historical aggregates from active snapshots.

Run after Alembic 0003, with the live import service paused or during a quiet
period. Existing contributor row locks prevent double counting if imports do
happen concurrently. A transaction is committed for each contributor.
"""
from ..db import connect
from ..recommendations.aggregates import apply_snapshot


def main():
    processed = skipped = 0
    with connect() as db:
        snapshot_owners = db.execute('''
            SELECT DISTINCT contributor_id FROM contribution_snapshots
            WHERE active=true ORDER BY contributor_id
        ''').fetchall()
    for owner_row in snapshot_owners:
        owner = owner_row['contributor_id']
        with connect() as db:
            with db.transaction():
                # Re-read after acquiring the writer lock; don't use a stale ID.
                locked = db.execute('SELECT id FROM contributors WHERE id=%s FOR UPDATE', (owner,)).fetchone()
                if not locked:
                    continue
                snapshots = db.execute('''
                    SELECT id,source,content_sha256 FROM contribution_snapshots
                    WHERE contributor_id=%s AND active=true ORDER BY source
                ''', (owner,)).fetchall()
                for row in snapshots:
                    if apply_snapshot(db, owner, row['source'], row['id'], row['content_sha256']):
                        processed += 1
                    else:
                        skipped += 1
    print(f'Historical aggregates: updated {processed}, unchanged {skipped} active snapshots')


if __name__ == '__main__':
    main()
