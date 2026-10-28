"""Exact-ID catalogue resolution. No fuzzy merges or provider-specific schema."""

from .providers.registry import get_provider


class CatalogueConflict(ValueError):
    """Identifier evidence conflicts with an existing catalogue identity."""


def _attach_metadata(db, recording_id, source_track_id, track, source):
    db.execute('''
        INSERT INTO recording_metadata
            (recording_id,title,primary_artist,album,source_track_id,provenance)
        VALUES (%s,%s,%s,%s,%s,%s)
        ON CONFLICT (recording_id) DO NOTHING
    ''', (recording_id, track.title, track.artists[0], track.album,
          source_track_id, source))


def resolve_track(db, track, source: str = 'spotify_extended_history', *, allow_synthetic=False) -> int:
    """Return source_track.id; recordings.id remains the canonical MDB58 ID.

    Caller must hold a database transaction. Advisory locks serialize
    overlapping namespace+identifier imports across concurrent connections.
    """
    try:
        provider = get_provider(source, allow_synthetic=allow_synthetic)
        source_ids, recording_ids = provider.normalise(track)
    except ValueError as exc:
        raise CatalogueConflict(str(exc)) from exc

    for ident in sorted((*source_ids, *recording_ids), key=lambda x: (x.namespace, x.value)):
        db.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))',
                   (ident.namespace + ':' + ident.value,))
    found = set()
    for ident in source_ids:
        row = db.execute('SELECT source_track_id FROM external_identifiers WHERE namespace=%s AND external_id=%s',
                         (ident.namespace, ident.value)).fetchone()
        if row:
            found.add(row['source_track_id'])
    if len(found) > 1:
        raise CatalogueConflict('Conflicting source identities; requires manual review')

    if found:
        source_track_id = next(iter(found))
        recording_id = db.execute('SELECT recording_id FROM source_tracks WHERE id=%s',
                                  (source_track_id,)).fetchone()['recording_id']
        for ident in recording_ids:
            mapped = db.execute('SELECT recording_id FROM recording_identifiers WHERE namespace=%s AND external_id=%s',
                                (ident.namespace, ident.value)).fetchone()
            if mapped and mapped['recording_id'] != recording_id:
                db.execute('''INSERT INTO recording_links(source_track_id,target_recording_id,method,active)
                    VALUES (%s,%s,%s,false)''',
                    (source_track_id, mapped['recording_id'], 'conflict:submitted_musicbrainz_id'))
            elif not mapped:
                db.execute('''INSERT INTO recording_identifiers(recording_id,namespace,external_id)
                    VALUES (%s,%s,%s) ON CONFLICT(namespace,external_id) DO NOTHING''',
                    (recording_id, ident.namespace, ident.value))
        for ident in source_ids:
            db.execute('''INSERT INTO external_identifiers(source_track_id,namespace,external_id)
                VALUES (%s,%s,%s) ON CONFLICT(namespace,external_id) DO NOTHING''',
                (source_track_id, ident.namespace, ident.value))
        _attach_metadata(db, recording_id, source_track_id, track, source)
        return source_track_id

    existing_recordings = set()
    for ident in recording_ids:
        row = db.execute('SELECT recording_id FROM recording_identifiers WHERE namespace=%s AND external_id=%s',
                         (ident.namespace, ident.value)).fetchone()
        if row:
            existing_recordings.add(row['recording_id'])
    if len(existing_recordings) > 1:
        raise CatalogueConflict('Conflicting recording identities')
    recording_id = next(iter(existing_recordings)) if existing_recordings else db.execute(
        'INSERT INTO recordings DEFAULT VALUES RETURNING id').fetchone()['id']
    source_track_id = db.execute('''
        INSERT INTO source_tracks(recording_id,title,primary_artist,album)
        VALUES (%s,%s,%s,%s) RETURNING id''',
        (recording_id, track.title, track.artists[0], track.album)).fetchone()['id']
    for position, artist in enumerate(track.artists):
        db.execute('INSERT INTO artist_credits VALUES (%s,%s,%s)',
                   (source_track_id, position, artist))
    for ident in source_ids:
        db.execute('''INSERT INTO external_identifiers(source_track_id,namespace,external_id)
            VALUES (%s,%s,%s)''', (source_track_id, ident.namespace, ident.value))
    for ident in recording_ids:
        db.execute('''INSERT INTO recording_identifiers(recording_id,namespace,external_id)
            VALUES (%s,%s,%s) ON CONFLICT(namespace,external_id) DO NOTHING''',
            (recording_id, ident.namespace, ident.value))
    _attach_metadata(db, recording_id, source_track_id, track, source)
    return source_track_id
