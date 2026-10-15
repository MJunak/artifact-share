# Changelog

## Unreleased

- Add a Mastra integration with native tools and an optional `MCPServer` wrapper.
- Add GitHub Actions checks for the server, Mastra adapter, and container build.
- Ignore all local `.env` variants while retaining the public `.env.example` template.

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-10-14

### Added
- Persistent JSON storage for interactive artifacts via `window.artifactDB`.
- Personal namespaces isolated by browser identity and collaborative shared namespaces.
- Artifact-scoped, 24-hour HMAC capabilities; no admin/API credential is exposed to artifact code.
- Configurable 20 MB per-artifact and 1 MB per-value limits, with tests for isolation, forgery, publication state and quota enforcement.

## [0.3.0] - 2026-10-06

### Added
- `ADMIN_URL`: serve the admin UI and API on a separate, e.g. VPN-only, hostname while share links use `PUBLIC_URL`. Admin and API routes return 404 on every other host.
- `/raw` may be framed by both origins.
- Deployment guide section "Public links, private admin", with a Traefik path allowlist.

## [0.2.0] - 2026-10-06

### Added
- Named, revocable API tokens with `publish` and `admin` scopes, optional expiry and last-used tracking (UI page and `/api/tokens`).
- `bin/artifact` CLI.
- `GET /api/whoami` and `DELETE /api/sessions` (log out everywhere).
- `PUBLIC_URL`, `TRUST_PROXY` and `ORPHAN_FILE_HOURS` settings.
- Test suite with `node:test`: API, tokens, security regressions, CLI.
- Documentation in `docs/`.

### Security
These changes come from an internal security review.
- Server-side sessions with a `__Host-` cookie; logout now revokes the session.
- The CSRF check no longer accepts a cookie when any `Authorization` header is present. Cookie writes require JSON, a same-origin `Origin` and `Sec-Fetch-Site`.
- The login body is capped at 4 KB. Failed Bearer attempts are throttled like logins. `X-Forwarded-For` is honoured only with `TRUST_PROXY`.
- A malformed cookie no longer causes HTTP 500.
- `/static/index.html` is no longer served. The admin UI and API cannot be framed.
- Files of unpublished artifacts are no longer public, and the shared cache lifetime drops from 1 year to 5 minutes.
- The upload MIME type is derived from the extension only.
- Absolute URLs come from `PUBLIC_URL` instead of the `Host` header.
- Startup refuses `ADMIN_TOKEN` shorter than 32 characters, and a `CONTENT_URL` on a sibling subdomain.
- Container hardening in `compose.yml`.

## [0.1.0] - 2026-10-06

### Added
- Initial version: admin UI with editor and live preview, HTML and Markdown artifacts, image uploads, versions, publish toggle, sandboxed viewer, Docker image.
