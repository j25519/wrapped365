from .base import split_identifiers


class SpotifyProvider:
    source = 'spotify_extended_history'

    def normalise(self, track):
        # Keep the original wire contract: historical Spotify submissions can
        # legitimately include MusicBrainz and other allowed identifiers.
        return split_identifiers(track)
