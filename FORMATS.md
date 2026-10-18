# Spotify listening history formats used by Wrapped 365

## Extended Streaming History (preferred)

Spotify currently delivers a ZIP containing one or more JSON files, often nested within a directory, with names such as `Streaming_History_Audio_2018-2026_0.json`. Older exports may instead call these files `endsong_0.json`, `endsong_1.json`, and so on. Each file contains a top-level **JSON array of playback event objects**. Example (illustrative, not private data):

```json
[
  {
    "ts": "2026-10-17T12:34:56Z",
    "username": "example_username",
    "platform": "Linux",
    "ms_played": 208000,
    "conn_country": "GB",
    "ip_addr_decrypted": null,
    "user_agent_decrypted": null,
    "master_metadata_track_name": "Example Song",
    "master_metadata_album_artist_name": "Example Artist",
    "master_metadata_album_album_name": "Example Album",
    "spotify_track_uri": "spotify:track:4u7EnebtmKWzUH433cf5Qv",
    "episode_name": null,
    "episode_show_name": null,
    "spotify_episode_uri": null,
    "reason_start": "trackdone",
    "reason_end": "trackdone",
    "shuffle": false,
    "skipped": false,
    "offline": false,
    "offline_timestamp": null,
    "incognito_mode": false
  }
]
```

Important fields:

| Field | Type | Meaning | Used in app? |
| --- | --- | --- | --- |
| `ts` | UTC timestamp string | When playback **ended** | Yes |
| `ms_played` | integer | Milliseconds of playback | Yes |
| `master_metadata_track_name` | string or null | Song name | Yes |
| `master_metadata_album_artist_name` | string or null | Artist | Yes |
| `master_metadata_album_album_name` | string or null | Album | Yes |
| `spotify_track_uri` | Spotify track URI or null | Spotify track identifier | For links and duplicate detection |
| `platform` | string | Platform/device identifier | Yes, grouped for statistics |
| `skipped`, `shuffle`, `offline` | boolean or null | Playback behaviour | Yes |
| `reason_start`, `reason_end` | string or null | Playback triggers | Used only for exact-event deduplication |
| `spotify_episode_uri`, `episode_name`, `episode_show_name` | URI/strings/null | Podcast content | Used to exclude podcast episodes |
| `username`, `conn_country`, `ip_addr` / `ip_addr_decrypted`, `user_agent_decrypted`, `offline_timestamp`, `incognito_mode` | various | Account/network/other metadata | **Discarded**, not stored |

Some fields vary or are null in older exports. Spotify may include additional fields. The app never keeps raw event objects after generating a report.

## Account Data (shorter history)

If Extended Streaming History audio files are unavailable, Wrapped 365 also recognises `StreamingHistory_music_0.json`, `StreamingHistory0.json`, etc. These generally contain the last year's records with a smaller schema:

```json
[
  {
    "endTime": "2026-10-17 12:34",
    "artistName": "Example Artist",
    "trackName": "Example Song",
    "msPlayed": 208000
  }
]
```

`endTime` is interpreted as UTC. These files omit album and several device/skip details, so relevant charts will be less complete. If the archive contains both types, Extended Streaming History takes priority to avoid counting overlapping events twice.

## Other archive files

Spotify may include podcast/video history, PDFs containing field definitions, Wrapped information, playlist information, billing data, and other personal data. Wrapped 365 deliberately ignores these files for music analytics. **Don't manually extract or upload the whole ZIP anywhere else** to use this app: select the original ZIP in the browser.

## Counting rules

Only music events where `ms_played >= 30000` are counted towards music streams, listening minutes, artists, tracks, albums, and time charts. Explicit skip, shuffle, and offline percentages use all identifiable music events for which the corresponding flag is present. Dates are shown and grouped in UTC. Tracks are grouped by case-insensitive artist + title, so alternate releases may be merged; albums are grouped by artist + album title. Within an archive, exact duplicate events are removed. Statistics may therefore differ from Spotify's own Wrapped statistics.

## References

- [Spotify: Understanding your data](https://support.spotify.com/uk/article/understanding-your-data/) (official field descriptions)
- [Spotify data export analysis](https://blog.ortham.net/posts/2024-12-21-spotify-streaming-history-part-1/) (sample JSON record)
- The `Read Me First - Extended Streaming History` file included in your actual Spotify export is authoritative for that archive.
