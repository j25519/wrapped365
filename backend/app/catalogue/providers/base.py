"""Shared interface for source-specific catalogue identities."""
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class CatalogueIdentity:
    namespace: str
    value: str


class ProviderAdapter(Protocol):
    source: str

    def normalise(self, track) -> tuple[list[CatalogueIdentity], list[CatalogueIdentity]]:
        """Return (source-track IDs, recording-level IDs) without fuzzy matching."""
        ...


def split_identifiers(track) -> tuple[list[CatalogueIdentity], list[CatalogueIdentity]]:
    sources, recordings = [], []
    for identifier in track.identifiers:
        ident = CatalogueIdentity(identifier.namespace, identifier.value)
        if ident.namespace == 'musicbrainz.recording':
            recordings.append(ident)
        elif ident.namespace.endswith('.track') or ident.namespace == 'listenbrainz.msid':
            sources.append(ident)
        else:
            raise ValueError(f'Unsupported identifier namespace: {ident.namespace}')
    if not sources:
        raise ValueError('At least one provider track identity is required')
    return sources, recordings
