# syntax=docker/dockerfile:1
# One frontend Dockerfile for both editions, with two selectable Caddy listeners.
FROM caddy:2-alpine
# Caddy's upstream binary carries CAP_NET_BIND_SERVICE=+ep for 80/443. Drop
# the file capability so --cap-drop ALL works when listening on port 6967.
RUN apk add --no-cache --virtual .remove-caddy-cap libcap \
    && setcap -r /usr/bin/caddy \
    && test -z "$(getcap /usr/bin/caddy)" \
    && apk del .remove-caddy-cap
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data \
    HOME=/tmp \
    WRAPPED365_NETWORK_MODE=lan
WORKDIR /srv/wrapped365
COPY Caddyfile Caddyfile.lan Caddyfile.proxy /etc/caddy/
COPY index.html styles.css app.js demo-tracks.yaml demo-playlists.yaml jszip.min.js favicon.svg LICENSE-JSZIP.txt VERSION ./
# MDB58.js exists in the full build context, but is deliberately missing from
# the standalone build context. A temporary BuildKit bind mount allows us to
# copy it ONLY when available without ever embedding other repository files.
RUN --mount=type=bind,source=.,target=/source,readonly \
    if [ -f /source/MDB58.js ]; then cp /source/MDB58.js /srv/wrapped365/MDB58.js; fi
USER 10001:10001
EXPOSE 6967
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile.lan", "--adapter", "caddyfile"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD if [ "$WRAPPED365_NETWORK_MODE" = "proxy" ]; then \
        wget -q -O /dev/null http://127.0.0.1:6967/; \
    else \
        wget --no-check-certificate -q -O /dev/null https://127.0.0.1:6967/; \
    fi || exit 1
