# Wrapped 365 — central deployment configuration

This update uses Compose's `.env` as the single source of truth for the Wrapped 365 **deployment mode**, browser URL, image edition, and MDB58 origin.

It does not configure external services (Cloudflare Access, DNS, VPS Caddy).

## Files

- `.env.example`: editable configuration template; copy to `.env` on each host.
- `compose.yaml`: standalone by default; `mdb58` and `antivirus` opt-in profiles.
- `Caddyfile`: shared static assets, headers, and (full only) API routing.
- `Caddyfile.lan`: HTTPS via Caddy's local CA on port 6967.
- `Caddyfile.proxy`: plain HTTP on port 6967, for an isolated upstream.
- `Dockerfile`: copies both Caddy listener files; includes `MDB58.js` only if it is present in the **build context** (which the standalone workflow excludes).
- `.github/workflows/publish-standalone.yml` and `publish-full.yml`: build both architectures and smoke test the selected frontend in **both modes**.

Copy files into the repository preserving paths. Replace the existing `.github/workflows/publish*.yml` files; remove the obsolete `publish.yml` if it is still present. Keep `.env` out of Git (already ignored in this project).

## LAN configuration

Copy `.env.example` to `.env`, then set, for example:

```dotenv
WRAPPED365_NETWORK_MODE=lan
WRAPPED365_PUBLIC_ORIGIN=https://192.168.1.219:6967
WRAPPED365_LAN_IP=192.168.1.219
WRAPPED365_LAN_HOST=asus-box.local
WRAPPED365_HOST_BIND=0.0.0.0
WRAPPED365_IMAGE_TAG=beta-standalone
```

Start standalone:

```sh
docker compose up -d
```

The site is served directly over HTTPS using `tls internal`. Install/trust Caddy's local CA on client devices. MDB58 accepts state changing requests only from the exact origin in `WRAPPED365_PUBLIC_ORIGIN`. If you use the `.local` name in your browser instead of the IP, set the origin to `https://asus-box.local:6967` (same allowed origin, one canonical URL).

## VPS reverse proxy configuration

Set, for example:

```dotenv
WRAPPED365_NETWORK_MODE=proxy
WRAPPED365_PUBLIC_ORIGIN=https://beta.example.com
WRAPPED365_HOST_BIND=127.0.0.1
WRAPPED365_IMAGE_TAG=beta-full
MDB58_IMAGE_TAG=beta-full
```

Set **real** values for `POSTGRES_PASSWORD`, `MDB58_INVITE_PEPPER`, and `MDB58_ADMIN_SETUP_TOKEN` by running `openssl rand -hex 32` three times.

For the full build:

```sh
docker compose --profile mdb58 up -d
```

If `MDB58_CLAMAV_REQUIRED=true`, start with both profiles:

```sh
docker compose --profile mdb58 --profile antivirus up -d
```

When your outer VPS Caddy runs as a host service, its (separately managed) Caddyfile can contain:

```caddyfile
beta.example.com {
    reverse_proxy 127.0.0.1:6967
}
```

HTTPS termination happens at the **outer** Caddy. The inner Wrapped 365 Caddy listens over **HTTP only**, on port 6967 bound to loopback. Do NOT open port 6967 publicly.

If outer Caddy itself runs in Docker, `127.0.0.1` inside that container is NOT the Docker host. Instead connect both proxies to a private Docker network, remove the host-published frontend port where possible, and proxy to the Wrapped 365 service name `wrapped365:6967`. This example assumes host Caddy.

## Validation

```sh
# Shows the enabled containers, interpolated image tags and selected listener.
docker compose config
# Full stack topology (requires actual secrets):
docker compose --profile mdb58 config --services
# External security headers:
curl -I https://beta.example.com/
# Internal listener on the VPS (expected HTTP):
curl -I http://127.0.0.1:6967/
# Ensure the backend is not bound to a public host port:
docker compose ps
```

Do not expose the raw origin publicly simply because it sits behind proxied DNS. Protect it at the tunnel/network edge.

## Notes and limits

- `WRAPPED365_PUBLIC_ORIGIN` is the **exact browser origin**: scheme, hostname, and optional port, with no path and no trailing `/`. Compose maps it into `MDB58_ALLOWED_ORIGIN` for the Python backend.
- Network mode changes require recreating the frontend container: `docker compose up -d --force-recreate wrapped365`.
- Compose profiles select **services**, not image editions: use a `*-full` frontend image with the `mdb58` profile, and `*-standalone` otherwise.
- A disabled profile does not remove already-running services. Use `docker compose --profile mdb58 down` when intentionally shutting down the full stack; normal `down` preserves named volumes unless `-v` is supplied.
- `MDB58_CLAMAV_REQUIRED=true` without the `antivirus` profile will fail closed. This is intentional.
- Inactive Compose profiles don't prevent environment substitution. Therefore the sample uses empty defaults for MDB58-only secrets; **check real secrets before starting full**.
- This package has been structurally inspected; Docker image builds and live Caddy `validate` should still run in GitHub Actions after committing.
