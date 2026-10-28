"""Provider-neutral catalogue metadata and retained historical item statistics.

Revision ID: 0003
Revises: 0002

All existing recording and source_track IDs are preserved. Historical aggregate
statistics are never linked to a contributor. Active-contribution deltas are
kept separately and disappear on account deletion.
"""
from alembic import op

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('''
        CREATE TABLE recording_metadata (
            recording_id BIGINT PRIMARY KEY REFERENCES recordings(id),
            title TEXT NOT NULL,
            primary_artist TEXT NOT NULL,
            album TEXT,
            source_track_id BIGINT REFERENCES source_tracks(id),
            provenance TEXT NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    ''')
    # Choose the oldest known source metadata deterministically. This backfill
    # does not merge recordings or change any existing recording IDs.
    op.execute('''
        INSERT INTO recording_metadata
            (recording_id, title, primary_artist, album, source_track_id, provenance)
        SELECT recording_id, title, primary_artist, album, id, 'legacy.source_tracks'
        FROM (
            SELECT DISTINCT ON (recording_id)
                id, recording_id, title, primary_artist, album
            FROM source_tracks
            ORDER BY recording_id, created_at, id
        ) first_source
        ON CONFLICT (recording_id) DO NOTHING
    ''')
    op.execute('''
        CREATE TABLE aggregate_model_state (
            singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
            model_version TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    ''')
    op.execute("INSERT INTO aggregate_model_state(singleton, model_version) VALUES (true, 'implicit-1')")
    op.execute('''
        CREATE TABLE track_aggregate_stats (
            recording_id BIGINT PRIMARY KEY REFERENCES recordings(id),
            weight_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
            weight_sq_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
            support_count BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT nonnegative_track_support CHECK (support_count >= 0)
        )
    ''')
    op.execute('''
        CREATE VIEW track_preference_summary AS
        SELECT recording_id,
            CASE WHEN support_count > 0 THEN weight_sum / support_count ELSE 0 END AS weighted_score,
            support_count, weight_sum, weight_sq_sum, updated_at
        FROM track_aggregate_stats
    ''')
    op.execute('''
        CREATE TABLE track_pair_aggregate_stats (
            recording_a BIGINT NOT NULL REFERENCES recordings(id),
            recording_b BIGINT NOT NULL REFERENCES recordings(id),
            weight_product_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
            shared_listener_count BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (recording_a, recording_b),
            CONSTRAINT pair_order CHECK (recording_a < recording_b),
            CONSTRAINT nonnegative_pair_support CHECK (shared_listener_count >= 0)
        )
    ''')
    op.execute('''CREATE INDEX track_pair_by_second ON track_pair_aggregate_stats(recording_b)''')
    op.execute('''
        CREATE TABLE item_similarities (
            recording_a BIGINT NOT NULL REFERENCES recordings(id),
            recording_b BIGINT NOT NULL REFERENCES recordings(id),
            similarity DOUBLE PRECISION NOT NULL,
            model_version TEXT NOT NULL,
            calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (recording_a, recording_b, model_version),
            CONSTRAINT similarity_pair_order CHECK (recording_a < recording_b),
            CONSTRAINT similarity_range CHECK (similarity >= 0 AND similarity <= 1)
        )
    ''')
    op.execute('''
        CREATE TABLE contributor_aggregate_state (
            contributor_id BIGINT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
            source TEXT NOT NULL,
            snapshot_id BIGINT REFERENCES contribution_snapshots(id) ON DELETE SET NULL,
            content_sha256 CHAR(64) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (contributor_id, source)
        )
    ''')
    op.execute('''
        CREATE TABLE contributor_track_deltas (
            contributor_id BIGINT NOT NULL,
            source TEXT NOT NULL,
            recording_id BIGINT NOT NULL REFERENCES recordings(id),
            weight DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (contributor_id, source, recording_id),
            FOREIGN KEY (contributor_id, source)
                REFERENCES contributor_aggregate_state(contributor_id, source)
                ON DELETE CASCADE,
            CONSTRAINT preference_weight_range CHECK (weight > 0 AND weight <= 1)
        )
    ''')


def downgrade():
    # Explicit downgrade only; it intentionally discards derived statistics.
    op.execute('DROP TABLE IF EXISTS contributor_track_deltas')
    op.execute('DROP TABLE IF EXISTS contributor_aggregate_state')
    op.execute('DROP TABLE IF EXISTS item_similarities')
    op.execute('DROP TABLE IF EXISTS track_pair_aggregate_stats')
    op.execute('DROP VIEW IF EXISTS track_preference_summary')
    op.execute('DROP TABLE IF EXISTS track_aggregate_stats')
    op.execute('DROP TABLE IF EXISTS aggregate_model_state')
    op.execute('DROP TABLE IF EXISTS recording_metadata')
