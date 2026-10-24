"""MDB58 v1, permanently namespaced catalogue IDs and snapshot aggregates.
Revision ID: 0001
Revises:
"""
from alembic import op
revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    sql = '''
    CREATE TABLE contributors (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      consent_version TEXT NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE TABLE invitations (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      token_digest BYTEA NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      redeemed_by BIGINT REFERENCES contributors(id),
      redeemed_at TIMESTAMPTZ,
      revoked BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE auth_sessions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      contributor_id BIGINT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
      token_digest BYTEA NOT NULL UNIQUE,
      csrf_digest BYTEA NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE recordings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      canonical_id BIGINT REFERENCES recordings(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (canonical_id IS NULL OR canonical_id <> id)
    );
    CREATE TABLE source_tracks (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recording_id BIGINT NOT NULL REFERENCES recordings(id),
      title TEXT NOT NULL,
      primary_artist TEXT NOT NULL,
      album TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE external_identifiers (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_track_id BIGINT NOT NULL REFERENCES source_tracks(id),
      namespace TEXT NOT NULL,
      external_id TEXT NOT NULL,
      UNIQUE(namespace, external_id)
    );
    CREATE TABLE recording_identifiers (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recording_id BIGINT NOT NULL REFERENCES recordings(id),
      namespace TEXT NOT NULL,
      external_id TEXT NOT NULL,
      UNIQUE(namespace, external_id)
    );
    CREATE TABLE artist_credits (
      source_track_id BIGINT NOT NULL REFERENCES source_tracks(id),
      credit_position SMALLINT NOT NULL,
      artist_name TEXT NOT NULL,
      PRIMARY KEY(source_track_id, credit_position)
    );
    CREATE TABLE recording_links (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_track_id BIGINT NOT NULL REFERENCES source_tracks(id),
      target_recording_id BIGINT NOT NULL REFERENCES recordings(id),
      method TEXT NOT NULL,
      confidence NUMERIC(5,4),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE submissions (
      id UUID PRIMARY KEY,
      contributor_id BIGINT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      archive_sha256 CHAR(64) NOT NULL,
      content_sha256 CHAR(64),
      total_chunks SMALLINT NOT NULL CHECK(total_chunks BETWEEN 1 AND 256),
      state TEXT NOT NULL DEFAULT 'staging' CHECK(state IN ('staging', 'committed', 'duplicate', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE submission_chunks (
      submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      chunk_index SMALLINT NOT NULL,
      content BYTEA NOT NULL,
      sha256 CHAR(64) NOT NULL,
      PRIMARY KEY(submission_id, chunk_index)
    );
    CREATE TABLE contribution_snapshots (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      contributor_id BIGINT NOT NULL REFERENCES contributors(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      submission_id UUID NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
      content_sha256 CHAR(64) NOT NULL,
      aggregation_version TEXT NOT NULL,
      first_week DATE NOT NULL,
      last_week DATE NOT NULL,
      active BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK(first_week <= last_week)
    );
    CREATE UNIQUE INDEX one_active_contribution ON contribution_snapshots(contributor_id,source) WHERE active;
    CREATE INDEX snapshots_owner ON contribution_snapshots(contributor_id);
    CREATE TABLE weekly_track_stats (
      snapshot_id BIGINT NOT NULL REFERENCES contribution_snapshots(id) ON DELETE CASCADE,
      source_track_id BIGINT NOT NULL REFERENCES source_tracks(id),
      week_start DATE NOT NULL,
      events INTEGER NOT NULL,
      duration_known INTEGER NOT NULL,
      qualifying_plays INTEGER,
      played_ms BIGINT,
      skip_known INTEGER NOT NULL,
      skips INTEGER,
      shuffle_known INTEGER NOT NULL,
      shuffled INTEGER,
      immediate_repeats INTEGER,
      time_known INTEGER NOT NULL,
      utc_hour_buckets INTEGER[],
      weekday_events INTEGER,
      weekend_events INTEGER,
      PRIMARY KEY(snapshot_id, source_track_id, week_start),
      CHECK(events > 0),
      CHECK(skip_known <= events AND shuffle_known <= events AND duration_known <= events AND time_known <= events)
    );
    CREATE INDEX weekly_track_lookup ON weekly_track_stats(source_track_id,week_start);
    CREATE TABLE weekly_session_stats (
      snapshot_id BIGINT NOT NULL REFERENCES contribution_snapshots(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      session_count INTEGER,
      session_duration_ms BIGINT,
      active_days SMALLINT,
      PRIMARY KEY(snapshot_id, week_start)
    );
    '''
    for statement in sql.split(';'):
        if statement.strip(): op.execute(statement)


def downgrade():
    op.execute('''DROP TABLE IF EXISTS weekly_session_stats, weekly_track_stats, contribution_snapshots,
        submission_chunks, submissions, recording_links, artist_credits, recording_identifiers, external_identifiers,
        source_tracks, recordings, auth_sessions, invitations, contributors CASCADE;''')
