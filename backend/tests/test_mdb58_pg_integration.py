"""Optional transaction-rollback PostgreSQL integration test.

Set MDB58_PG_TEST_URL to an isolated database URL ending `_test` or
`_synthetic` after applying Alembic 0003; this test never commits its rows.
"""
import hashlib
import os
import uuid
from datetime import date
from urllib.parse import urlparse

import pytest


def test_catalogue_replacement_and_deletion_retain_historical_aggregates(monkeypatch):
    url = os.environ.get('MDB58_PG_TEST_URL', '')
    if not url:
        pytest.skip('Set MDB58_PG_TEST_URL to an isolated, migrated PostgreSQL test database')
    if not urlparse(url).path.strip('/').endswith(('_synthetic', '_test')):
        pytest.fail('Refusing to use MDB58_PG_TEST_URL without a test-only database suffix')
    monkeypatch.setenv('DATABASE_URL', url)
    from app.db import connect
    from app.models import Identifier, Track
    from app.catalogue.resolver import resolve_track
    from app.recommendations.aggregates import apply_snapshot

    db = connect()
    try:
        # Keep everything in a transaction that is ALWAYS rolled back.
        owner = db.execute("INSERT INTO contributors(consent_version) VALUES ('synthetic-fixture') RETURNING id").fetchone()['id']
        first_track = Track(ref='t1', identifiers=[Identifier(namespace='synthetic.track',
            value='0003-postgres-integration-track')], title='PG fixture song',
            artists=['PG fixture artist'], album='PG fixture album')
        source_id = resolve_track(db, first_track, 'synthetic', allow_synthetic=True)
        source_id_again = resolve_track(db, first_track, 'synthetic', allow_synthetic=True)
        assert source_id_again == source_id
        recording = db.execute('SELECT recording_id FROM source_tracks WHERE id=%s', (source_id,)).fetchone()['recording_id']

        def create_snapshot(revision, plays):
            sid = uuid.uuid4()
            digest = hashlib.sha256(f'integration:{sid}'.encode()).hexdigest()
            db.execute('''INSERT INTO submissions
                (id,contributor_id,source,archive_sha256,content_sha256,total_chunks,state)
                VALUES (%s,%s,'synthetic',%s,%s,1,'committed')''',
                (sid, owner, digest, digest))
            snapshot = db.execute('''INSERT INTO contribution_snapshots
                (contributor_id,source,submission_id,content_sha256,aggregation_version,first_week,last_week,active)
                VALUES (%s,'synthetic',%s,%s,'cplus-1','2026-10-26','2026-10-26',false)
                RETURNING id''', (owner, sid, digest)).fetchone()['id']
            db.execute('''INSERT INTO weekly_track_stats
                (snapshot_id,source_track_id,week_start,events,duration_known,
                 qualifying_plays,played_ms,skip_known,skips,shuffle_known,shuffled,
                 immediate_repeats,time_known,utc_hour_buckets,weekday_events,weekend_events)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (snapshot, source_id, date(2026, 10, 26), plays, plays,
                 plays, plays * 180_000, plays, 0, plays, 1,
                 1, plays, [1, 0, plays - 1, 0], plays, 0))
            return snapshot, digest

        first, first_digest = create_snapshot(1, 10)
        assert apply_snapshot(db, owner, 'synthetic', first, first_digest)
        assert not apply_snapshot(db, owner, 'synthetic', first, first_digest)
        score = db.execute('SELECT weighted_score,support_count FROM track_preference_summary WHERE recording_id=%s',
                           (recording,)).fetchone()
        assert score['support_count'] == 1
        assert 0 < score['weighted_score'] <= 1

        second, second_digest = create_snapshot(2, 23)
        assert apply_snapshot(db, owner, 'synthetic', second, second_digest)
        after_replace = db.execute('SELECT support_count FROM track_aggregate_stats WHERE recording_id=%s',
                                   (recording,)).fetchone()
        assert after_replace['support_count'] == 1, 'Replacement must not double count the listener'
        db.execute('DELETE FROM contributors WHERE id=%s', (owner,))
        assert not db.execute('SELECT 1 FROM contributor_track_deltas WHERE contributor_id=%s',
                              (owner,)).fetchone()
        after_delete = db.execute('SELECT support_count FROM track_aggregate_stats WHERE recording_id=%s',
                                  (recording,)).fetchone()
        assert after_delete['support_count'] == 1, 'Historical totals must survive account deletion'
        assert db.execute('SELECT id FROM recordings WHERE id=%s', (recording,)).fetchone()
    finally:
        db.rollback()
        db.close()
