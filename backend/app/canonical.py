"""Deterministic content digest for validated MDB58 data.

No float fields. RFC 8785 and ordinary compact JSON coincide for our ASCII keys,
integer values and Unicode text when keys are sorted, and strings are escaped
consistently. Both client and server use the SERVER digest as the authority.
"""
import hashlib
import json
from .models import Contribution


def content_digest(payload: Contribution) -> str:
    doc = payload.model_dump(mode='json', exclude_none=False)
    del doc['submission']['id']
    del doc['submission']['archive_sha256']
    # Normalise temporary, user-chosen track refs to exact source identity.
    # This makes content hashing independent of the order in which tracks were parsed.
    identities = {t['ref']: min((x['namespace'], x['value']) for x in t['identifiers']) for t in doc['tracks']}
    stable_refs = {ref: f't{i+1}' for i, (ref, _) in enumerate(sorted(identities.items(), key=lambda p:p[1]))}
    for t in doc['tracks']:
        t['ref'] = stable_refs[t['ref']]
    for t in doc['weekly_tracks']:
        t['track_ref'] = stable_refs[t['track_ref']]
    doc['tracks'].sort(key=lambda t: int(t['ref'][1:]))
    doc['weekly_tracks'].sort(key=lambda t: (t['track_ref'], t['week_start']))
    doc['weekly_sessions'].sort(key=lambda s: s['week_start'])
    for t in doc['tracks']:
        t['identifiers'].sort(key=lambda x: (x['namespace'], x['value']))
    canonical = json.dumps(doc, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()
