# Wrapped 365 serves only static assets. No Node, API or application backend runs in the image.
FROM caddy:2-alpine

# The upstream Caddy binary carries CAP_NET_BIND_SERVICE=+ep for ports 80/443.
# With --cap-drop ALL, that file capability can make execve fail with EPERM.
# This app only binds to 6967, so remove the capability at build time and
# retain the strict no-capabilities deployment. libcap is build-time only.
RUN apk add --no-cache --virtual .remove-caddy-cap libcap \
    && setcap -r /usr/bin/caddy \
    && test -z "$(getcap /usr/bin/caddy)" \
    && apk del .remove-caddy-cap

# 6967 is unprivileged. Caddy's runtime files go into /tmp so its root filesystem
# can be read-only with a writable tmpfs mounted at /tmp.
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data \
    HOME=/tmp

WORKDIR /srv/wrapped365
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html styles.css app.js demo-tracks.yaml jszip.min.js favicon.svg LICENSE-JSZIP.txt VERSION ./

# Numeric, non-root UID/GID; does not depend on /etc/passwd or a writable /home.
USER 10001:10001
EXPOSE 6967
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:6967/ || exit 1
