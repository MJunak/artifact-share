# Deployment

artifact-share is a single container with one volume. It speaks plain HTTP; terminate TLS in a reverse proxy.

- [Docker Compose](#docker-compose)
- [Portainer](#portainer)
- [Reverse proxy (Traefik, Caddy, nginx)](#reverse-proxy)
- [Backups](#backups)
- [Upgrades](#upgrades)
- [Production checklist](#production-checklist)

## Docker Compose

```bash
cp .env.example .env
$EDITOR .env                 # at least ADMIN_TOKEN and PUBLIC_URL
docker compose up -d --build
docker compose logs -f
```

The bundled [`compose.yml`](../compose.yml) already applies container hardening:

| Setting | Why |
|---|---|
| `read_only: true` + `tmpfs: /tmp` | Root filesystem is immutable; only `/data` is writable |
| `cap_drop: [ALL]` | The app needs no Linux capabilities |
| `no-new-privileges` | No setuid escalation |
| `mem_limit: 256m`, `pids_limit: 100` | Bounded resources |
| Non-root user `node` | Set in the [Dockerfile](../Dockerfile) |
| Health check on `/healthz` | `docker ps` shows `healthy` |

Data lives in the named volume `artifact-data` (mounted at `/data`).

## Portainer

**Option A: build on the host (repository stack).**

1. *Stacks → Add stack → Repository*.
2. Repository URL: your Git remote. Compose path: `compose.yml`.
3. Add the environment variables from [configuration.md](configuration.md) (at least `ADMIN_TOKEN` and `PUBLIC_URL`).
4. *Deploy the stack*. Portainer clones the repository and builds the image on the target environment.

**Option B: pre-built image.**
Build and push once (`docker build -t registry.example.com/artifact-share:0.2.0 .`). In the stack editor, replace `build: .` with `image: registry.example.com/artifact-share:0.2.0`.

## Reverse proxy

The app must see HTTPS as `https://` in `PUBLIC_URL`. Set `TRUST_PROXY=true` so rate limiting uses the real client IP.

### Traefik (Docker labels)

```yaml
services:
  artifact-share:
    # … as in compose.yml, but without "ports:" and attached to Traefik's network
    networks: [proxy]
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.artifacts.rule=Host(`artifacts.example.com`)
      - traefik.http.routers.artifacts.entrypoints=websecure
      - traefik.http.routers.artifacts.tls.certresolver=letsencrypt
      - traefik.http.routers.artifacts.middlewares=artifacts-limits
      - traefik.http.middlewares.artifacts-limits.buffering.maxRequestBodyBytes=30000000
      - traefik.http.services.artifacts.loadbalancer.server.port=3000
networks:
  proxy:
    external: true
```

### Traefik (file provider, app on another host)

```yaml
http:
  routers:
    artifacts:
      rule: Host(`artifacts.example.com`)
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      service: artifacts
  services:
    artifacts:
      loadBalancer:
        servers:
          - url: http://100.64.0.10:8790   # e.g. the app host's VPN IP
```

### Caddy

```caddyfile
artifacts.example.com {
  request_body { max_size 30MB }
  reverse_proxy 127.0.0.1:8790
}
```

### nginx

```nginx
server {
  listen 443 ssl;
  server_name artifacts.example.com;
  client_max_body_size 30m;
  location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Public links, private admin

You can publish share links on the internet and keep the admin UI and API reachable only from a VPN:

1. Set `PUBLIC_URL` to the public hostname and `ADMIN_URL` to the private one. The app then refuses admin and API requests on every host except `ADMIN_URL` (404).
2. On the public proxy, also route only the public paths. That way a request never reaches the app unless it is meant to be public:

```yaml
http:
  routers:
    artifacts-public:
      rule: Host(`artifacts.example.com`) && (PathPrefix(`/a/`) || PathPrefix(`/raw/`) || PathPrefix(`/f/`) || PathPrefix(`/frame/db/`) || PathPrefix(`/static/`) || Path(`/healthz`))
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      middlewares: [artifacts-public-headers]
      service: artifacts
  middlewares:
    artifacts-public-headers:
      headers:
        stsSeconds: 31536000
  services:
    artifacts:
      loadBalancer:
        servers:
          - url: http://100.64.0.10:8792   # app host's VPN IP, published via compose.override.yml
```

3. Publish the second port only on the VPN interface (`compose.override.yml`):

```yaml
services:
  artifact-share:
    ports:
      - "100.64.0.10:8792:3000"
```

### Separate content domain (optional)

To let artifacts use `localStorage` etc., route a **second registrable domain** to the same container and set `CONTENT_URL`, e.g. `artifacts.example.com` plus `example-usercontent.com`. On the content host the app serves only `/raw/*` and `/f/*`. Read [security.md](security.md#separate-content-origin) before enabling this.

## Backups

Everything is in the data volume. SQLite runs in WAL mode, so copy it with the SQLite backup API instead of `cp`:

```bash
docker run --rm -v artifact-share_artifact-data:/data -v "$PWD":/backup alpine sh -c \
  'apk add -q sqlite && sqlite3 /data/artifacts.db ".backup /backup/artifacts.db" && tar -C /data -czf /backup/files.tgz files'
```

To restore, stop the container and put `artifacts.db` and `files/` back into the volume.

## Upgrades

```bash
git pull
docker compose up -d --build
```

The schema is created and extended automatically at startup (`CREATE TABLE IF NOT EXISTS`). Check [CHANGELOG.md](../CHANGELOG.md) for breaking changes.

## Production checklist

- [ ] `ADMIN_TOKEN` generated randomly (≥ 32 chars) and stored in a password manager
- [ ] `PUBLIC_URL` set to the exact HTTPS origin
- [ ] TLS terminated by the proxy, HTTP redirected to HTTPS
- [ ] `TRUST_PROXY=true` only behind your own proxy
- [ ] Port bound to loopback or a private interface, never `0.0.0.0`
- [ ] Admin UI not on the internet: `ADMIN_URL` set to a private hostname, or the proxy routes only public paths
- [ ] `CONTENT_URL` empty, or on a separate registrable domain
- [ ] Proxy body-size limit ≥ `MAX_UPLOAD_MB`
- [ ] Backups of the data volume scheduled
- [ ] Day-to-day automation uses scoped API tokens, not `ADMIN_TOKEN`
