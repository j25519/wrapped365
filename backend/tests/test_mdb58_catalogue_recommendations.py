"""Pure unit tests for the Phase 1A/1B provider interface and feature extraction."""
from datetime import date, timedelta
from types import SimpleNamespace

from app.catalogue.providers.registry import get_provider
from app.devtools.seed_synthetic import create_profiles, weekly_events
from app.recommendations.aggregates import track_weights, pair_products, MAX_PAIR_ITEMS


def test_spotify_and_synthetic_are_isolated():
    spotify = get_provider('spotify_extended_history')
    assert spotify.source == 'spotify_extended_history'
    synthetic = get_provider('synthetic', allow_synthetic=True)
    assert synthetic.source == 'synthetic'
    try:
        get_provider('synthetic')
        assert False, 'Production registry must reject the synthetic provider'
    except ValueError:
        pass


def test_score_respects_skip_and_repeat_and_unknown_metrics():
    week = date(2026, 10, 26)
    rows = [
        {'recording_id': 1, 'week_start': week, 'events': 20,
         'qualifying_plays': 20, 'played_ms': 5_000_000, 'skip_known': 20,
         'skips': 0, 'immediate_repeats': 5},
        {'recording_id': 2, 'week_start': week, 'events': 20,
         'qualifying_plays': 10, 'played_ms': 2_000_000, 'skip_known': 20,
         'skips': 10, 'immediate_repeats': 0},
        {'recording_id': 3, 'week_start': week, 'events': 6,
         'qualifying_plays': None, 'played_ms': None, 'skip_known': 0,
         'skips': None, 'immediate_repeats': None},
    ]
    weights = track_weights(rows)
    assert weights[1] == 1.0
    assert 0 < weights[3] < weights[1]
    assert weights[2] < weights[1]


def test_time_decay_and_cross_provider_recording_aggregation():
    now = date(2026, 10, 26)
    rows = [
        {'recording_id': 10, 'week_start': now, 'events': 15,
         'qualifying_plays': 15, 'played_ms': None, 'skip_known': 0,
         'skips': None, 'immediate_repeats': None},
        {'recording_id': 10, 'week_start': now - timedelta(weeks=5), 'events': 5,
         'qualifying_plays': 5, 'played_ms': None, 'skip_known': 0,
         'skips': None, 'immediate_repeats': None},
        {'recording_id': 11, 'week_start': now - timedelta(weeks=90), 'events': 15,
         'qualifying_plays': 15, 'played_ms': None, 'skip_known': 0,
         'skips': None, 'immediate_repeats': None},
    ]
    result = track_weights(rows)
    assert len(result) == 2
    assert result[10] > result[11]


def test_pairs_are_ordered_deterministic_and_capped():
    weights = {i: 0.3 + (i / 1000) for i in range(1, MAX_PAIR_ITEMS + 11)}
    pairs = pair_products(weights)
    assert len(pairs) == MAX_PAIR_ITEMS * (MAX_PAIR_ITEMS - 1) // 2
    assert all(a < b for a, b in pairs)
    assert pairs == pair_products(dict(reversed(list(weights.items()))))


def test_synthetic_profiles_are_reproducible():
    tracks = [{'artist': f'Artist {n % 35}', 'external_id': f'{n:032d}',
               'seconds': 180, 'title': f'Track {n}', 'album': 'Album'}
              for n in range(200)]
    first = list(create_profiles(tracks, contributors=6, seed=58))
    second = list(create_profiles(tracks, contributors=6, seed=58))
    assert first == second
    import random
    events = list(weekly_events(random.Random(58), first[0][1], first[0][2], date(2026, 10, 26)))
    assert events
    assert all(s.week_start.weekday() == 0 for _, s in events)
