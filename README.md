# Wrapped 365 — your listening, unwrapped

A Spotify-inspired, self-hostable, completely browser-side web app for Spotify Extended Streaming History ZIP exports. No Spotify API, login, backend, telemetry, external fonts, CDN, or server-side storage.

## Run it

In this directory:

```sh
python3 -m http.server 6967 --bind 127.0.0.1
```

Open **http://127.0.0.1:6967** in a current Chromium, Firefox, or Safari browser. This is a static file server: it never receives your Spotify ZIP; the browser reads it directly. Alternatively, serve the directory with Caddy or another static web server. HTTPS is recommended for remotely hosted deployments.

Do not serve behind an upload endpoint or put archive files into the web root. You upload them *through* the webpage using the browser file picker; they are not transferred over HTTP.

## Import formats

See [FORMATS.md](FORMATS.md) for the documented export JSON structures and supported field names.


- Spotify **Extended Streaming History** ZIP: `Streaming_History_Audio_*.json` or older `endsong_*.json` (possibly inside a folder). Files are JSON arrays of events with `ts`, `ms_played`, `master_metadata_track_name`, `master_metadata_album_artist_name`, `master_metadata_album_album_name`, `spotify_track_uri`, `platform`, `shuffle`, `skipped`, `offline`, etc.
- Also accepts `StreamingHistory_music_*.json`, `StreamingHistory0.json`, etc. from **Account data**, which generally covers only the last year, if no Extended Streaming History files are present.
- Direct `.json` import of a single history file is also supported.
- Podcast and video records are ignored. Short listens (<30 seconds) do not count towards music plays or listening time. Explicit skips/shuffle/offline stats use all valid music listening events. Report dates use UTC.
- Artist/title-based matching groups alternate Spotify recordings/releases with the same artist and title. Album counts are grouped by artist and album name.

Each file is read and parsed separately. ZIP files are parsed by a **locally bundled JSZip 3.10.1** script, with no CDN or network requests. Spotify audio JSON files are processed individually after extraction. A practical limit of 180 MB per JSON file and 2 GB total uncompressed candidate files is enforced. Be aware that ZIP parsing and aggregating a very large listening history may require substantial browser memory.

## Privacy and browser report history

- A first-party `wrapped365_browser_id` cookie contains a random identifier for the local browser's report collection. No tracking service sees this identifier.
- Reports are stored in IndexedDB under that identifier, **in the browser**. They contain aggregated artists, tracks, albums, and timeline statistics only, **not** raw plays, usernames, IP addresses, or user agents.
- Clearing your site's cookie creates a fresh identifier. IndexedDB data may remain orphaned until site data is cleared; you can delete accessible reports via the Saved Reports page.
- Saved report history supports reopening, deleting, and downloading aggregated JSON summaries.
- Each import is an independent report. Imports are **not automatically merged** across separate ZIPs; within a ZIP, duplicated event records are deduplicated. The report archive is not a full raw history backup: keep the original Spotify ZIP safe.
- Browser storage quotas and private/incognito mode may prevent persistence. Clearing browser site data deletes saved reports.
- All calculations, charting, and ZIP decompression happen locally. No outgoing requests are made by the app (the official help link and optional per-track Spotify links only open if clicked).

## Docker image

The included Dockerfile uses unprivileged port **6967** and runs as **UID/GID 10001:10001**.

```sh
docker build -t wrapped365 .
docker run --rm -p 127.0.0.1:6967:6967 wrapped365
```

Open http://127.0.0.1:6967. The container runs Caddy as a **static file server only**, using unprivileged UID/GID **10001:10001**. The included Caddyfile prevents background API connections with a Content Security Policy, and does not expose any upload endpoint. To publish it behind your existing Caddy instance, reverse proxy to port 6967 or serve the static files directly.

## Version control and automatic GHCR publishing

Treat the GitHub repository as the **canonical source** and the ChatGPT Library folder **Wrapped 365** as a persistent project snapshot for ongoing discussions. See [`CHANGELOG.md`](CHANGELOG.md) and [`VERSION`](VERSION) for the project version.

1. Create a GitHub repository (suggested name `wrapped-365`) with **main** as the default branch. Commit these files to the repository root, including `.github/workflows/publish.yml`, and push to `main`.
2. GitHub Actions runs a JavaScript syntax check, builds the container, and verifies the static site responds on **6967** while running as UID **10001** with a read-only root filesystem. On a successful `main` push it publishes `ghcr.io/<owner>/<repo>:latest`; Git tags such as `v0.2.0` publish that tag too, plus a SHA tag. Pull requests build and test but do not publish.
3. The workflow authenticates to GHCR using the repository-scoped `GITHUB_TOKEN` with `packages: write`, so **no personal access token is needed for publishing**. For anonymous pulls, set the package visibility to **Public** in GitHub's package settings after its first publication. Private packages require an authenticated `docker login ghcr.io` on the deploying machine.
4. On your Docker host, copy `.env.example` to `.env`, edit `WRAPPED365_IMAGE` to the repository's **lowercase** GHCR image name, then deploy using Compose:

```sh
cp .env.example .env
# Edit the image address in .env to ghcr.io/YOUR_OWNER/YOUR_REPO:latest
docker compose pull
docker compose up -d
```

The Compose configuration binds **127.0.0.1:6967** by default (suitable for a reverse proxy running on the host). If clients must connect directly across your LAN, change the binding to `6967:6967`. If your reverse proxy is itself in a container, connect both containers to a shared Docker network instead of using loopback.

The container is explicitly non-root (`USER 10001:10001`), drops capabilities, has a read-only root filesystem, and only uses a temporary writable `/tmp` for Caddy's runtime state. No persistent Docker volume, Spotify credentials, or server-side data store is required.

To use a versioned deployment rather than following `latest`, set `WRAPPED365_IMAGE` to `ghcr.io/<owner>/<repo>:v0.2.0` after pushing the `v0.2.0` git tag.

## Deploy with Caddy

```caddyfile
wrapped365.example.net {
    root * /srv/wrapped365
    file_server
    encode zstd gzip
}
```

Copy all files in this directory to `/srv/wrapped365`. Protect public deployments however you like; the application has no authentication (only a browser cookie for report separation).

## Future

An optional Navidrome adapter can be added for synchronising scrobble history, but is not included in this MVP because an API connector changes the network/privacy model. The Spotify importer does not use Spotify's API.

## Export structure source

Spotify's current documentation: https://support.spotify.com/uk/article/understanding-your-data/

## Third-party notice

`jszip.min.js` includes JSZip v3.10.1 (Copyright Stuart Knightley and contributors), distributed under the MIT licence. It is bundled locally solely to read ZIP files in the browser. https://stuk.github.io/jszip/

### Report history / cookies

Browsers generally do not provide reliable cookie or IndexedDB support when opening a webpage directly from `file://`, so use `http://localhost`, `http://127.0.0.1`, or HTTPS. This app sets a same-site cookie with a random identifier; the cookie is only a lookup key, **not** a copy of your report. The report is stored separately in the same browser's IndexedDB. Different browsers and devices maintain separate report collections. Clearing site data clears stored reports. Deleting just the cookie hides previously saved reports under a new identity; clear site data to remove orphaned browser data.

### Statistics notes

Wrapped 365 excludes Spotify podcast and video events and music events shorter than 30 seconds from play counts and listening time; explicit skip/shuffle/offline rates are computed from all identifiable music events with the corresponding flag. Spotify's `ts` is the playback **end time**, and all chart grouping uses UTC. Results are therefore not guaranteed to reproduce Spotify's internal Wrapped calculations. Metadata such as artist genres, track duration, and album art isn't available reliably in the export, and the app makes no API calls to fetch it.
