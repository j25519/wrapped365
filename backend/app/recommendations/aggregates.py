"""Incrementally retain contributor-independent listening preference statistics.

One full active snapshot contributes one vector for each (contributor, source).
On replacement, the prior vector is subtracted before the replacement is added.
On deletion, contributor-specific deltas are erased via FK cascade and the
historical aggregate tables intentionally remain unchanged.

This is NOT an anonymisation guarantee for small populations. Do not expose
low-support statistics directly to untrusted clients.
"""
from collections import defaultdict
from datetime import date
from itertools import combinations
from math import exp, log1p

MODEL_VERSION = 'implicit-1'
MAX_PAIR_ITEMS = 48


def track_weights(rows: list[dict]) -> dict[int, float]:
    """Build a normalised implicit preference vector from weekly recording rows.

    All temporal decay is relative to the latest week in the snapshot, so old
    exports are not arbitrarily penalised for the date they were uploaded.
    Missing skip/duration data is unknown, not zero skips/duration.
    """
    if not rows:
        return {}
    newest = max(r['week_start'] for r in rows)
    by_recording = defaultdict(lambda: {'plays': 0.0, 'minutes': 0.0, 'repeats': 0.0,
                                       'skips': 0.0, 'skip_known': 0})
    for row in rows:
        rid = row['recording_id']
        weeks_ago = max(0, (newest - row['week_start']).days // 7)
        freshness = exp(-weeks_ago / 52.0)  # 52-week characteristic time
        plays = row['qualifying_plays']
        if plays is None:
            plays = row['events'] * 0.35
        item = by_recording[rid]
        item['plays'] += plays * freshness
        if row['played_ms'] is not None:
            item['minutes'] += max(0, row['played_ms']) / 60000.0 * freshness
        if row['immediate_repeats'] is not None:
            item['repeats'] += row['immediate_repeats'] * freshness
        if row['skips'] is not None and row['skip_known']:
            item['skips'] += row['skips']
            item['skip_known'] += row['skip_known']

    raw = {}
    for rid, item in by_recording.items():
        base = (log1p(item['plays']) +
                0.10 * log1p(item['minutes']) +
                0.18 * log1p(item['repeats']))
        if item['skip_known']:
            skip_ratio = min(1, item['skips'] / item['skip_known'])
            base *= max(0.25, 1.0 - 0.60 * skip_ratio)
        if base > 0:
            raw[rid] = base
    if not raw:
        return {}
    peak = max(raw.values())
    return {rid: round(max(0.001, min(1.0, value / peak)), 8)
            for rid, value in sorted(raw.items())}


def pair_products(weights: dict[int, float]):
    """Sparse co-preference totals, capped to avoid O(catalogue²) per listener."""
    selected = sorted(sorted(weights, key=lambda rid: (-weights[rid], rid))[:MAX_PAIR_ITEMS])
    return {(a, b): weights[a] * weights[b] for a, b in combinations(selected, 2)}


def snapshot_weights(db, snapshot_id: int) -> dict[int, float]:
    rows = db.execute('''
        SELECT st.recording_id, w.week_start, w.events, w.qualifying_plays,
               w.played_ms, w.skip_known, w.skips, w.immediate_repeats
        FROM weekly_track_stats w
        JOIN source_tracks st ON st.id=w.source_track_id
        WHERE w.snapshot_id=%s
    ''', (snapshot_id,)).fetchall()
    return track_weights(rows)


def _adjust_tracks(db, weights: dict[int, float], sign: int):
    for recording_id, weight in weights.items():
        db.execute('''
            INSERT INTO track_aggregate_stats
                (recording_id, weight_sum, weight_sq_sum, support_count)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (recording_id) DO UPDATE SET
                weight_sum=CASE WHEN track_aggregate_stats.support_count+EXCLUDED.support_count=0
                    THEN 0 ELSE GREATEST(0,track_aggregate_stats.weight_sum+EXCLUDED.weight_sum) END,
                weight_sq_sum=CASE WHEN track_aggregate_stats.support_count+EXCLUDED.support_count=0
                    THEN 0 ELSE GREATEST(0,track_aggregate_stats.weight_sq_sum+EXCLUDED.weight_sq_sum) END,
                support_count=track_aggregate_stats.support_count+EXCLUDED.support_count,
                updated_at=now()
        ''', (recording_id, sign * weight, sign * weight * weight, sign))


def _adjust_pairs(db, weights: dict[int, float], sign: int):
    for (a, b), product in pair_products(weights).items():
        db.execute('''
            INSERT INTO track_pair_aggregate_stats
                (recording_a,recording_b,weight_product_sum,shared_listener_count)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (recording_a,recording_b) DO UPDATE SET
                weight_product_sum=CASE WHEN track_pair_aggregate_stats.shared_listener_count+EXCLUDED.shared_listener_count=0
                    THEN 0 ELSE GREATEST(0,track_pair_aggregate_stats.weight_product_sum+EXCLUDED.weight_product_sum) END,
                shared_listener_count=track_pair_aggregate_stats.shared_listener_count+EXCLUDED.shared_listener_count,
                updated_at=now()
        ''', (a, b, sign * product, sign))


def apply_snapshot(db, contributor_id: int, source: str,
                   snapshot_id: int, content_sha256: str) -> bool:
    """Apply an active/replacement snapshot exactly once, in caller transaction.

    Caller must first SELECT the contributor FOR UPDATE (serialises imports,
    replacement, deletion and backfill). Do not call after deleting old deltas.
    """
    config = db.execute('''SELECT model_version FROM aggregate_model_state
        WHERE singleton=true FOR SHARE''').fetchone()
    if not config or config['model_version'] != MODEL_VERSION:
        raise RuntimeError('Historical aggregate score version mismatch: explicit rebuild/migration required')
    state = db.execute('''
        SELECT snapshot_id,content_sha256 FROM contributor_aggregate_state
        WHERE contributor_id=%s AND source=%s
    ''', (contributor_id, source)).fetchone()
    if state and state['snapshot_id'] == snapshot_id and state['content_sha256'] == content_sha256:
        return False
    old = {
        row['recording_id']: row['weight']
        for row in db.execute('''
            SELECT recording_id,weight FROM contributor_track_deltas
            WHERE contributor_id=%s AND source=%s
        ''', (contributor_id, source)).fetchall()
    }
    new = snapshot_weights(db, snapshot_id)
    if old:
        _adjust_tracks(db, old, -1)
        _adjust_pairs(db, old, -1)
    if new:
        _adjust_tracks(db, new, 1)
        _adjust_pairs(db, new, 1)
    db.execute('''
        INSERT INTO contributor_aggregate_state
            (contributor_id,source,snapshot_id,content_sha256)
        VALUES (%s,%s,%s,%s)
        ON CONFLICT (contributor_id,source) DO UPDATE SET
            snapshot_id=EXCLUDED.snapshot_id,
            content_sha256=EXCLUDED.content_sha256,
            updated_at=now()
    ''', (contributor_id, source, snapshot_id, content_sha256))
    db.execute('DELETE FROM contributor_track_deltas WHERE contributor_id=%s AND source=%s',
               (contributor_id, source))
    for recording_id, weight in new.items():
        db.execute('''INSERT INTO contributor_track_deltas
            (contributor_id,source,recording_id,weight) VALUES (%s,%s,%s,%s)''',
            (contributor_id, source, recording_id, weight))
    return True
