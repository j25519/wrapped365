from .base import split_identifiers


class SyntheticProvider:
    source = 'synthetic'

    def normalise(self, track):
        sources, recordings = split_identifiers(track)
        if any(i.namespace != 'synthetic.track' for i in sources) or recordings:
            raise ValueError('Synthetic fixtures require synthetic.track only')
        return sources, recordings
