# Changelog

## 0.2.0 — 18 October 2026

- Added a GitHub Actions CI/CD workflow that checks JavaScript, smoke-tests an unprivileged Docker container, and publishes multi-architecture images to GitHub Container Registry (GHCR).
- Migrated the container's HTTP listener and health check from port 8080 to **6967**.
- Set the runtime user to numeric UID/GID 10001 and added a hardened Compose deployment using a read-only filesystem, dropped Linux capabilities, and a small writable `/tmp`.
- Added a pinned report source archive convention, a project changelog, and JSZip licence notice.

## 0.1.0 — 18 October 2026

- Initial Spotify Extended Streaming History ZIP importer, listening statistics, and browser-only report history.
