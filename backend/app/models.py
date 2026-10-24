"""MDB58 v1 strict wire contract. Unknown keys are rejected throughout."""
from datetime import date
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Identifier(Strict):
    namespace: str = Field(pattern=r'^[a-z][a-z0-9_.]{1,49}$', max_length=50)
    value: str = Field(min_length=1, max_length=200)


class Track(Strict):
    ref: str = Field(pattern=r'^t[1-9][0-9]{0,7}$')
    identifiers: list[Identifier] = Field(min_length=1, max_length=20)
    title: str = Field(min_length=1, max_length=300)
    artists: list[str] = Field(min_length=1, max_length=30)
    album: str | None = Field(default=None, max_length=300)

    @model_validator(mode='after')
    def identifiers_unique(self):
        pairs = [(i.namespace, i.value) for i in self.identifiers]
        if len(pairs) != len(set(pairs)): raise ValueError('duplicate identifiers')
        if not any(i.namespace.endswith('.track') for i in self.identifiers):
            raise ValueError('provider track identity is required')
        if any(not name.strip() or len(name) > 200 for name in self.artists): raise ValueError('invalid artist')
        return self


class WeeklyTrack(Strict):
    track_ref: str
    week_start: date
    events: int = Field(ge=1, le=100000)
    duration_known: int = Field(ge=0)
    qualifying_plays: int | None
    played_ms: int | None = Field(ge=0, default=None)
    skip_known: int = Field(ge=0)
    skips: int | None = Field(ge=0)
    shuffle_known: int = Field(ge=0)
    shuffled: int | None = Field(ge=0)
    immediate_repeats: int | None = Field(ge=0)
    time_known: int = Field(ge=0)
    utc_hour_buckets: list[int] | None
    weekday_events: int | None = Field(ge=0)
    weekend_events: int | None = Field(ge=0)

    @model_validator(mode='after')
    def coherent(self):
        if self.week_start.weekday() != 0: raise ValueError('week_start must be Monday (UTC)')
        if self.played_ms is not None and self.played_ms > self.events * 86400000:
            raise ValueError('impossible listening duration')
        if self.duration_known > self.events or self.skip_known > self.events or self.shuffle_known > self.events or self.time_known > self.events:
            raise ValueError('coverage exceeds events')
        for known, positive in ((self.duration_known,self.qualifying_plays),(self.skip_known,self.skips),(self.shuffle_known,self.shuffled)):
            if known == 0 and positive is not None: raise ValueError('unknown metrics must be null')
            if known > 0 and (positive is None or positive > known): raise ValueError('invalid metric count')
        if (self.duration_known == 0) != (self.played_ms is None): raise ValueError('invalid duration')
        if self.immediate_repeats is not None and self.immediate_repeats > self.events: raise ValueError('invalid repeats')
        if self.time_known == 0:
            if any(x is not None for x in (self.utc_hour_buckets, self.weekday_events, self.weekend_events)):
                raise ValueError('unknown time buckets must be null')
        else:
            if self.utc_hour_buckets is None or len(self.utc_hour_buckets) != 4 or any(x < 0 for x in self.utc_hour_buckets) or sum(self.utc_hour_buckets) != self.time_known:
                raise ValueError('invalid hour buckets')
            if self.weekday_events is None or self.weekend_events is None or self.weekday_events + self.weekend_events != self.time_known:
                raise ValueError('invalid weekday counts')
        return self


class WeeklySession(Strict):
    week_start: date
    session_count: int | None = Field(ge=0)
    session_duration_ms: int | None = Field(ge=0)
    active_days: int | None = Field(ge=0, le=7)

    @model_validator(mode='after')
    def validate_week(self):
        if self.week_start.weekday() != 0: raise ValueError('session week must be Monday')
        if (self.session_count is None) != (self.session_duration_ms is None): raise ValueError('session data mismatch')
        return self


class SubmissionInfo(Strict):
    id: str = Field(pattern=r'^[0-9a-f-]{36}$')
    mode: Literal['replace_complete']
    archive_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    first_week: date
    last_week: date


class Contribution(Strict):
    schema_version: Literal['1.0']
    aggregation_version: Literal['cplus-1']
    source: Literal['spotify_extended_history']
    submission: SubmissionInfo
    tracks: list[Track] = Field(min_length=1, max_length=200000)
    weekly_tracks: list[WeeklyTrack] = Field(min_length=1, max_length=1500000)
    weekly_sessions: list[WeeklySession] = Field(max_length=3000)

    @model_validator(mode='after')
    def coherent(self):
        allowed = {'spotify.track','musicbrainz.track','musicbrainz.recording',
                   'apple_music.track','listenbrainz.track','listenbrainz.msid'}
        for track in self.tracks:
            if any(i.namespace not in allowed for i in track.identifiers):
                raise ValueError('unsupported identifier namespace')
        source_aliases = [(i.namespace,i.value) for track in self.tracks for i in track.identifiers if i.namespace!='musicbrainz.recording']
        if len(source_aliases)!=len(set(source_aliases)):
            raise ValueError('same provider identifier belongs to multiple track refs')
        refs = {track.ref for track in self.tracks}
        if len(refs) != len(self.tracks): raise ValueError('duplicate track refs')
        seen = set()
        for t in self.weekly_tracks:
            if t.track_ref not in refs: raise ValueError('unresolved track ref')
            key = (t.track_ref, t.week_start)
            if key in seen: raise ValueError('duplicate track/week')
            seen.add(key)
            if not self.submission.first_week <= t.week_start <= self.submission.last_week:
                raise ValueError('week outside stated coverage')
        weeks = {s.week_start for s in self.weekly_sessions}
        if len(weeks) != len(self.weekly_sessions): raise ValueError('duplicate session week')
        if self.submission.first_week.weekday() or self.submission.last_week.weekday() or self.submission.first_week > self.submission.last_week:
            raise ValueError('invalid submission coverage')
        if min(t.week_start for t in self.weekly_tracks) != self.submission.first_week or max(t.week_start for t in self.weekly_tracks) != self.submission.last_week:
            raise ValueError('coverage must match supplied track weeks')
        for t in self.weekly_sessions:
            if not self.submission.first_week <= t.week_start <= self.submission.last_week:
                raise ValueError('session out of range')
        return self


class ActivateRequest(Strict):
    invite: str = Field(min_length=16, max_length=150)


class ChunkRequest(Strict):
    index: int = Field(ge=0, lt=256)
    base64_data: str = Field(min_length=4, max_length=800000)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


class StartRequest(Strict):
    id: str = Field(pattern=r'^[0-9a-f-]{36}$')
    source: Literal['spotify_extended_history']
    archive_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    total_chunks: int = Field(ge=1, le=256)
