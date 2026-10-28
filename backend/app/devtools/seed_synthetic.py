"""Seed an isolated PostgreSQL test database with synthetic listening histories.

Example (from repository root, NOT from production):
  MDB58_SYNTHETIC_DATABASE=1 DATABASE_URL=postgresql://.../mdb58_synthetic \
    PYTHONPATH=backend python -m app.devtools.seed_synthetic \
    --catalogue demo-tracks.yaml --contributors 250 --months 12 --seed 58

The fixture never uses Spotify IDs and is forbidden from running against any
non-test database name. A seeded database should be reset via its dedicated
throwaway database/volume rather than deleting contributors (deletion retains
historical aggregate statistics by design).
"""
import argparse
import hashlib
import os
import random
import uuid
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlparse

import yaml
from ..catalogue.resolver import resolve_track
from ..db import connect
from ..models import Track, Identifier, WeeklyTrack
from ..recommendations.aggregates import apply_snapshot

SOURCE = 'synthetic'
_LAST_WEEK = date(2026, 10, 26)  # Fixed Monday for deterministic test fixtures.


def assert_test_database():
    url = os.environ.get('DATABASE_URL', '')
    database = urlparse(url).path.strip('/')
    flag = os.environ.get('MDB58_SYNTHETIC_DATABASE') == '1'
    if not flag or not database.endswith(('_synthetic', '_test')):
        raise RuntimeError('Refusing synthetic seeding: require MDB58_SYNTHETIC_DATABASE=1 '
                           'and a PostgreSQL database name ending _synthetic or _test')


def load_tracks(path: Path):
    data = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not isinstance(data.get('tracks'), list):
        raise ValueError('Expected demo-tracks.yaml with a tracks list')
    by_identity = {}
    for row in data['tracks']:
        title = str(row['title']).strip()
        artist = str(row['artist']).strip()
        album = str(row.get('album') or '').strip()
        seconds = int(row.get('seconds') or 180)
        if not title or not artist or seconds <= 0:
            continue
        key = (artist, title, album, seconds)
        if key not in by_identity:
            digest = hashlib.sha256('\0'.join(map(str, key)).encode()).hexdigest()[:32]
            by_identity[key] = {'artist': artist, 'title': title, 'album': album,
                                'seconds': seconds, 'external_id': digest}
    return list(by_identity.values())


def create_profiles(tracks, *, contributors: int, seed: int):
    """Fixed overlapping artist affinities, plus personal exploration and noise."""
    rng = random.Random(seed)
    artist_tracks = defaultdict(list)
    for track in tracks:
        artist_tracks[track['artist']].append(track)
    popular = sorted(artist_tracks, key=lambda a: (-len(artist_tracks[a]), a))
    artist_pools = [popular[offset::5] for offset in range(5)]
    for index in range(contributors):
        primary = index % 5
        secondary = (primary + rng.choice([1, 2, 3, 4])) % 5
        chosen_artists = set(rng.sample(artist_pools[primary], min(5, len(artist_pools[primary]))))
        chosen_artists.update(rng.sample(artist_pools[secondary], min(2, len(artist_pools[secondary]))))
        library = [t for artist in sorted(chosen_artists) for t in artist_tracks[artist]]
        # Choose a manageable active selection, ensuring many shared tracks
        # within an affinity pool and some spill-over between communities.
        if len(library) > 65:
            library = rng.sample(library, 65)
        additional = rng.sample(tracks, min(6, len(tracks)))
        distinct = {t['external_id']: t for t in (library + additional)}
        track_set = sorted(distinct.values(), key=lambda t: t['external_id'])
        if not track_set:
            raise ValueError('No usable tracks in catalogue')
        favourites = {t['external_id'] for t in rng.sample(track_set, min(9, len(track_set)))}
        yield index, track_set, favourites


def weeks_for_months(months):
    return max(1, int(round(months * 52 / 12)))


def weekly_events(rng, track_set, favourites, week_start):
    # Each listener has stable favourites and periodic exploratory sessions.
    count = min(len(track_set), rng.randint(3, 10))
    options = rng.choices(
        track_set,
        weights=[5 if t['external_id'] in favourites else 1 for t in track_set],
        k=count * 3,
    )
    week = {t['external_id']: t for t in options[:count * 3]}
    # Fixed shuffle order and bounded number of weekly tracks.
    picked = rng.sample(sorted(week.values(), key=lambda t: t['external_id']), min(count, len(week)))
    for track in picked:
        favourite = track['external_id'] in favourites
        events = rng.randint(8, 26) if favourite else rng.randint(1, 9)
        skips = rng.randint(0, max(0, events // (8 if favourite else 3)))
        plays = events - skips
        repeats = rng.randint(0, min(events, 4 if favourite else 1))
        duration_ms = int(track['seconds']) * 1000 * plays
        hours = [0, 0, 0, 0]
        for _ in range(events):
            hours[rng.choices(range(4), weights=[1, 2, 5, 3])[0]] += 1
        weekday = rng.randint(0, events)
        yield track, WeeklyTrack(
            track_ref='t1', week_start=week_start, events=events,
            duration_known=events, qualifying_plays=plays, played_ms=duration_ms,
            skip_known=events, skips=skips, shuffle_known=events,
            shuffled=rng.randint(0, events), immediate_repeats=repeats,
            time_known=events, utc_hour_buckets=hours,
            weekday_events=weekday, weekend_events=events - weekday,
        )


def seed(*, tracks, contributors, months, seed):
    assert_test_database()
    if contributors < 1 or contributors > 10000:
        raise ValueError('contributors must be within 1–10000')
    if months < 1 or months > 48:
        raise ValueError('months must be within 1–48')
    with connect() as db:
        already = db.execute("SELECT 1 FROM contribution_snapshots WHERE source='synthetic' LIMIT 1").fetchone()
        if already:
            raise RuntimeError('Synthetic data already exists; reset the throwaway test database to rerun')

    number_weeks = weeks_for_months(months)
    for number, track_set, favourites in create_profiles(tracks, contributors=contributors, seed=seed):
        rng = random.Random((seed << 20) + number)
        submission_id = uuid.uuid5(uuid.NAMESPACE_URL, f'mdb58-fixture:{seed}:{number}')
        checksum = hashlib.sha256(f'synthetic:{seed}:{number}:{months}'.encode()).hexdigest()
        with connect() as db:
            with db.transaction():
                contributor = db.execute('''INSERT INTO contributors(consent_version)
                    VALUES ('synthetic-fixture') RETURNING id''').fetchone()['id']
                db.execute('''INSERT INTO submissions
                    (id,contributor_id,source,archive_sha256,content_sha256,total_chunks,state)
                    VALUES (%s,%s,%s,%s,%s,1,'committed')''',
                    (submission_id, contributor, SOURCE, checksum, checksum))
                first_week = _LAST_WEEK - timedelta(weeks=number_weeks - 1)
                snapshot = db.execute('''INSERT INTO contribution_snapshots
                    (contributor_id,source,submission_id,content_sha256,aggregation_version,first_week,last_week,active)
                    VALUES (%s,%s,%s,%s,'cplus-1',%s,%s,true) RETURNING id''',
                    (contributor, SOURCE, submission_id, checksum, first_week, _LAST_WEEK)).fetchone()['id']

                identities = {}
                for t in track_set:
                    ident = Identifier(namespace='synthetic.track', value=t['external_id'])
                    model = Track(ref='t1', identifiers=[ident], title=t['title'],
                                  artists=[t['artist']], album=t['album'] or None)
                    identities[t['external_id']] = resolve_track(
                        db, model, source=SOURCE, allow_synthetic=True)
                for offset in range(number_weeks):
                    week_start = first_week + timedelta(weeks=offset)
                    for track, stat in weekly_events(rng, track_set, favourites, week_start):
                        db.execute('''INSERT INTO weekly_track_stats
                            (snapshot_id,source_track_id,week_start,events,duration_known,
                             qualifying_plays,played_ms,skip_known,skips,shuffle_known,shuffled,
                             immediate_repeats,time_known,utc_hour_buckets,weekday_events,weekend_events)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                            (snapshot, identities[track['external_id']], week_start,
                             stat.events, stat.duration_known, stat.qualifying_plays,
                             stat.played_ms, stat.skip_known, stat.skips,
                             stat.shuffle_known, stat.shuffled, stat.immediate_repeats,
                             stat.time_known, stat.utc_hour_buckets,
                             stat.weekday_events, stat.weekend_events))
                apply_snapshot(db, contributor, SOURCE, snapshot, checksum)
        if (number + 1) % 25 == 0 or number + 1 == contributors:
            print(f'Synthetic contributors: {number + 1}/{contributors}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalogue', type=Path, default=Path('demo-tracks.yaml'))
    parser.add_argument('--contributors', type=int, default=250)
    parser.add_argument('--months', type=int, default=12)
    parser.add_argument('--seed', type=int, default=58)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    assert_test_database()  # Check before reading input or writing any rows.
    tracks = load_tracks(args.catalogue)
    if args.dry_run:
        groups = list(create_profiles(tracks, contributors=args.contributors, seed=args.seed))
        print(f'Fixture preview: catalogue={len(tracks)}; listeners={len(groups)}; '
              f'weeks={weeks_for_months(args.months)}; seed={args.seed}')
        return
    seed(tracks=tracks, contributors=args.contributors, months=args.months, seed=args.seed)


if __name__ == '__main__':
    main()
