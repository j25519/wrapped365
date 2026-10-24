import copy
import json
import pytest
from app.models import Contribution
from app.canonical import content_digest


def fixture():
    return {
        'schema_version':'1.0','aggregation_version':'cplus-1','source':'spotify_extended_history',
        'submission':{'id':'550e8400-e29b-41d4-a716-446655440000','mode':'replace_complete','archive_sha256':'a'*64,'first_week':'2026-10-19','last_week':'2026-10-19'},
        'tracks':[{'ref':'t1','identifiers':[{'namespace':'spotify.track','value':'A'*22}],'title':'Song A','artists':['Artist A'],'album':'Album A'}],
        'weekly_tracks':[{'track_ref':'t1','week_start':'2026-10-19','events':3,'duration_known':3,'qualifying_plays':2,'played_ms':98000,
         'skip_known':0,'skips':None,'shuffle_known':3,'shuffled':1,'immediate_repeats':1,
         'time_known':3,'utc_hour_buckets':[1,1,0,1],'weekday_events':2,'weekend_events':1}],
        'weekly_sessions':[{'week_start':'2026-10-19','session_count':2,'session_duration_ms':98000,'active_days':2}]
    }


def validate(doc): return Contribution.model_validate_json(json.dumps(doc))


def test_valid_fixture():
    assert validate(fixture()).weekly_tracks[0].skips is None


def test_null_is_not_zero():
    doc=fixture();doc['weekly_tracks'][0]['skips']=0
    with pytest.raises(Exception): validate(doc)


def test_unknown_property_rejected():
    doc=fixture();doc['tracks'][0]['username']='someone'
    with pytest.raises(Exception): validate(doc)


def test_unequal_hour_buckets_rejected():
    doc=fixture();doc['weekly_tracks'][0]['utc_hour_buckets']=[0,0,0,1]
    with pytest.raises(Exception): validate(doc)


def test_not_monday_rejected():
    doc=fixture();doc['weekly_tracks'][0]['week_start']='2026-10-20'
    with pytest.raises(Exception): validate(doc)


def test_content_digest_ignores_transport_id_and_archive_hash():
    doc=fixture();a=content_digest(validate(doc))
    doc['submission']['id']='660e8400-e29b-41d4-a716-446655440000'
    doc['submission']['archive_sha256']='b'*64
    assert content_digest(validate(doc))==a


def test_canonical_ref_normalisation():
    doc=fixture();a=content_digest(validate(doc))
    doc['tracks'][0]['ref']='t42';doc['weekly_tracks'][0]['track_ref']='t42'
    assert content_digest(validate(doc))==a
