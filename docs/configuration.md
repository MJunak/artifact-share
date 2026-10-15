# Configuration

All settings are environment variables. With Docker Compose, put them in `.env` (see [`.env.example`](../.env.example)) or set them in the Portainer stack editor.

| Variable | Default | Description |
|---|---|---|
| `ADMIN_TOKEN` | **required** | Master secret for the admin login and the API. At least 32 characters; generate with `openssl rand -base64 32`. The server refuses to start with a shorter value. Rotating it does **not** revoke API tokens or sessions; use `DELETE /api/sessions` and revoke tokens for that. |
| `PUBLIC_URL` | derived from request | Base URL as seen by browsers, e.g. `https://artifacts.example.com` (no path, no trailing slash). Used for every absolute link and for the CSRF origin check. **Set it in every non-local deployment.** Without it, URLs are derived from the `Host` header, which is fine for local testing only. |
| `ADMIN_URL` | *(empty)* | Optional separate origin for the admin UI and API, e.g. a VPN-only hostname. When set, share links use `PUBLIC_URL`, while login, cookies and the CSRF check use `ADMIN_URL`, and the admin UI (`/`, `/new`, `/edit/*`, `/tokens`) and `/api/*` answer **only** on the `ADMIN_URL` host. Every other host gets just the public routes. Requires `PUBLIC_URL`. See [deployment.md](deployment.md#public-links-private-admin). |
| `CONTENT_URL` | *(empty)* | Optional separate origin that serves artifact content, so artifacts can use `localStorage`, IndexedDB, cookies, etc. **Must be on a different registrable domain** than `PUBLIC_URL` (e.g. `example-usercontent.com`); the server refuses to start with a sibling subdomain. Both hostnames must route to the same container. See [security.md](security.md#separate-content-origin). |
| `TRUST_PROXY` | `false` | Set to `true` when a reverse proxy you control sets `X-Forwarded-For` and `X-Forwarded-Proto`. Enables real client IPs for rate limiting (right-most `X-Forwarded-For` entry). Leave it off when the app is reachable directly. |
| `SITE_NAME` | `Artifacts` | Name shown in the UI, page titles and link previews. |
| `MAX_UPLOAD_MB` | `25` | Maximum size of a single uploaded file. |
| `MAX_CONTENT_MB` | `10` | Maximum size of an artifact's HTML/Markdown source. |
| `MAX_ARTIFACT_STORAGE_MB` | `20` | Maximum combined database storage across all personal and shared entries of one artifact. Text-encoded JSON only. |
| `MAX_STORAGE_VALUE_MB` | `1` | Maximum JSON-encoded size of a single artifact database value. Must not exceed `MAX_ARTIFACT_STORAGE_MB`. |
| `SESSION_DAYS` | `30` | Lifetime of a browser login. |
| `ORPHAN_FILE_HOURS` | `24` | Uploads that were never attached to an artifact (editor closed without saving) are deleted after this many hours. |
| `PORT` | `3000` | Port inside the container / process. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Location of `artifacts.db` and `files/`. |

Compose-only variables (used by [`compose.yml`](../compose.yml), not by the app):

| Variable | Default | Description |
|---|---|---|
| `BIND_ADDR` | `127.0.0.1` | Host interface the port is published on. Use a VPN/Tailscale IP or keep loopback behind a local proxy. Avoid `0.0.0.0`: Docker bypasses host firewalls such as UFW. |
| `HOST_PORT` | `8790` | Host port. |
| `IMAGE_TAG` | `latest` | Tag of the locally built image. |

## Examples

Behind Traefik on a public domain:

```dotenv
ADMIN_TOKEN=…
PUBLIC_URL=https://artifacts.example.com
TRUST_PROXY=true
BIND_ADDR=127.0.0.1
```

Private, VPN-only (e.g. Tailscale), plain HTTP:

```dotenv
ADMIN_TOKEN=…
PUBLIC_URL=http://home-server.tailnet-name.ts.net:8790
TRUST_PROXY=false
BIND_ADDR=100.64.0.10
```

Public share links, admin only over a VPN:

```dotenv
PUBLIC_URL=https://artifacts.example.com
ADMIN_URL=https://home-server.tailnet-name.ts.net:8790
TRUST_PROXY=true
```

With a separate content domain:

```dotenv
PUBLIC_URL=https://artifacts.example.com
CONTENT_URL=https://example-usercontent.com
```
