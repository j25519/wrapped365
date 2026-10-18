# Wrapped 365

<img width="3192" height="1881" alt="image" src="https://github.com/user-attachments/assets/0922d370-9d05-4efd-8088-b2e1817e14a4" />

## Deploy with Docker Compose

Grab the [`compose.yaml`](compose.yaml) file and put it in a directory on your Docker host. No source checkout or local image build is needed.

Then run:

```bash
docker compose pull
docker compose up -d wrapped365
```

Open **http://localhost:6967** on the Docker host. By default, the Compose file binds to `6967` and it will be available to all devices on your LAN. Change this to `127.0.0.1:6967` to bind to localhost only - recommended if running behind a reverse proxy.

## What is Wrapped 365?

Wrapped 365 is a self-hosted, Spotify inspired listening statistics dashboard. Upload your **Spotify Extended Streaming History ZIP** to explore your music listening habits across individual years or your entire account history.

All ZIP processing and analysis happen **in your browser**. There is no Spotify API integration, no login, and no server-side storage of listening data.

## Features

- Top artists, tracks, and albums by plays or listening time.
- Listening totals, yearly breakdowns, trends, and interactive charts.
- Listening habits, including activity by time and day, skips, shuffle, and devices.
- A local history of reports that you can reopen, delete, or export.
- Support for Spotify's current extended-history JSON format and older export formats.

Reports are saved in the browser using **IndexedDB**, with a first-party cookie identifying the local report collection. Clearing browser site data removes the saved reports.

## Technologies

- **HTML, CSS, and vanilla JavaScript** for the responsive interface and statistics engine.
- **JSZip** for reading Spotify ZIP exports entirely in the browser.
- **IndexedDB and cookies** for browser-local report history.
- **Caddy and Docker** for serving the static site on port **6967** as a non-root user.
- **GitHub Actions and GHCR** for building and publishing multi-architecture container images.
