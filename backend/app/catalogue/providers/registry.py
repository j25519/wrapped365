from .spotify import SpotifyProvider
from .synthetic import SyntheticProvider

_PROVIDER = {'spotify_extended_history': SpotifyProvider()}
_SYNTHETIC = SyntheticProvider()


def get_provider(source: str, *, allow_synthetic: bool = False):
    if source == 'synthetic' and allow_synthetic:
        return _SYNTHETIC
    try:
        return _PROVIDER[source]
    except KeyError as exc:
        raise ValueError(f'Unsupported contribution source: {source}') from exc
