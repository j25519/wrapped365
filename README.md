# Wrapped 365

Deep dive into your Spotify analytics locally within your browser. Discover the music that defined eras of your life.

## Now with themes!

<img width="2864" height="1877" alt="image" src="https://github.com/user-attachments/assets/f30a80bb-fc35-48b2-a8ec-8a6bb33b1228" />

<img width="2864" height="1885" alt="image" src="https://github.com/user-attachments/assets/c2240200-ac1c-47b3-a3fb-87d276028c05" />

<img width="2864" height="1850" alt="image" src="https://github.com/user-attachments/assets/0d3e137a-7233-4c5d-929d-fea2699d2d84" />

<img width="2864" height="1850" alt="image" src="https://github.com/user-attachments/assets/984ac1cf-96c6-46a0-8f87-61adc3fcfe15" />

<img width="2864" height="1850" alt="image" src="https://github.com/user-attachments/assets/77eb21b7-13fb-450c-8e8e-8f727e86a7bd" />

<img width="2618" height="1875" alt="image" src="https://github.com/user-attachments/assets/9e5106e6-9561-4756-adeb-5e4c87a5baf5" />

## Deploy with Docker Compose

Grab the [`compose.yaml`](compose.yaml) file and put it in a directory on your Docker host. No source checkout or local image build is needed.

Then run:

```bash
docker compose pull
docker compose up -d wrapped365
```

Open **http://localhost:6967** on the Docker host. By default, the Compose file binds to `6967` and it will be available to all devices on your LAN. Change this to `127.0.0.1:6967` to bind to localhost only - recommended if running behind a reverse proxy.

Wrapped 365 does not require elevated privileges. It runs inside a small Alpine Docker image. The default Docker Compose configuration runs the application as `user: "10001:10001"` and sets `no-new-privileges:true`. The default port, `6967`, is an unprivileged port. Feel free to change the UID/GID pair to any unprivileged user on your system if needed. I recommend a no-login account without a shell that is only a member of its own group as good security practice. You gain nothing running it from a `root` or `sudo` account, you just harm your OPSEC.

## What is Wrapped 365?

Wrapped 365 is a self-hosted, Spotify inspired listening statistics dashboard. Upload your **Spotify Extended Streaming History ZIP** to explore your music listening habits across individual years or your entire account history.

All ZIP processing and analysis happen **in your browser**. There is no Spotify API integration, no login, and no server-side storage of listening data.

## Features

- Top artists, tracks, and albums by plays or listening time.
- Listening totals, yearly breakdowns, trends, and interactive charts.
- Listening habits, including activity by time and day, skips, shuffle, and devices.
- Deep analysis into the music that defined eras of your life.
- Throwbacks to tracks, albums, and artists you once loved and may have forgotten.
- Enhanced playlist and social analytics, measuring whose recommendations shaped your tastes.
- A local history of reports that you can reopen, delete, or export.
- Support for Spotify's current extended-history JSON format and older export formats.

Reports are saved in the browser using **IndexedDB**, with a first party cookie identifying the local report collection. Clearing browser site data removes the saved reports.

### Listening Eras
Discover the musical chapters of your life through automatically identified listening eras, based on changes in your listening habits. Explore month-by-month statistics, defining tracks, artists, and albums, rediscovered favourites, forgotten songs, and periods of heavy rotation.

### Unified Search
Search your entire listening history for tracks, albums, and artists. Explore detailed statistics, listening timelines, popularity peaks, and connections to your listening eras. Search results include featured artists where available, with local metadata enrichment to identify additional artist credits.

### Much more to come!
Massive amount of new functionality on the roadmap, give us a star and watch this space! <3

## Technologies

- **HTML, CSS, and vanilla JavaScript** for the responsive interface and statistics engine.
- **JSZip** for reading Spotify ZIP exports entirely in the browser.
- **IndexedDB and cookies** for browser local report history.
- **Caddy and Docker** for serving the static site on port **6967** as a non-root user.
- **GitHub Actions and GHCR** for building and publishing multi-architecture container images.
