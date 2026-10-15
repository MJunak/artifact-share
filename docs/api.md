# REST API

Base URL: your `PUBLIC_URL`. All API responses are JSON.

## Authentication

Send a token as `Authorization: Bearer <token>`. Accepted tokens:

| Token | Scope | Where it comes from |
|---|---|---|
| `ADMIN_TOKEN` | `admin` | Environment variable. Use it for bootstrapping only. |
| `as_…` API token | `publish` or `admin` | Created in the UI under **API-Tokens**, or via `POST /api/tokens` |

- **`publish`** can manage artifacts and files.
- **`admin`** can additionally manage tokens and sessions.

A request with an `Authorization` header is judged on that header alone, and a session cookie is never used as a fallback. Failed attempts are rate-limited: 10 per client per minute, plus a global cap. While a client is throttled, the server answers `429` even for a valid token.

The browser UI uses a session cookie instead. Cookie-authenticated writes must be same-origin JSON requests ([security.md](security.md)).

## Errors

```json
{ "error": "content is required" }
```

| Status | Meaning |
|---|---|
| 400 | Invalid input |
| 401 | Missing or invalid credentials |
| 403 | Insufficient scope, or a cross-origin cookie request |
| 404 | Not found |
| 413 | Body too large |
| 415 | `Content-Type` must be `application/json` |
| 429 | Too many failed authentication attempts |

## Artifacts

### Object

```json
{
  "id": "Xk3pQ9vT2mLbHa",
  "title": "Weekly report",
  "description": "Shown in link previews",
  "kind": "html",
  "version": 3,
  "published": true,
  "views": 42,
  "size": 5120,
  "created_at": 1791316614604,
  "updated_at": 1791320000000,
  "url": "https://artifacts.example.com/a/Xk3pQ9vT2mLbHa",
  "content": "<!doctype html>…"
}
```

Timestamps are Unix milliseconds. `content` is only included on single-artifact responses. `kind` is `html` or `markdown`.

### Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/artifacts` | | List (without `content`), newest first |
| `POST` | `/api/artifacts` | `{title?, description?, kind?, content, published?, files?}` | Create. `files` is a list of file IDs uploaded beforehand that should belong to this artifact. Returns `201`. |
| `GET` | `/api/artifacts/:id` | | Get with content |
| `PUT`/`PATCH` | `/api/artifacts/:id` | any subset of the create fields | Update. A new version is created only when `content`, `kind` or `title` changes. |
| `DELETE` | `/api/artifacts/:id` | | Delete the artifact, its versions and its files |
| `GET` | `/api/artifacts/:id/versions` | | `[{version, title, kind, size, created_at}]`, newest first |
| `GET` | `/api/artifacts/:id/versions/:n` | | One version including content |

HTML content can be a fragment or a full document. Fragments are wrapped in a minimal HTML5 skeleton. Markdown is rendered with [marked](https://marked.js.org/) and a neutral stylesheet.

## Files

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/files?name=<filename>[&artifact=<id>]` | raw bytes | Upload. Returns `201` with the file object. |
| `GET` | `/api/files[?artifact=<id>]` | | List all files, or the files of one artifact |
| `DELETE` | `/api/files/:id` | | Delete |

```json
{
  "id": "q4GU4pdHTKjsGoQhAb7x",
  "artifact_id": "Xk3pQ9vT2mLbHa",
  "name": "chart.png",
  "mime": "image/png",
  "size": 48213,
  "created_at": 1791316614579,
  "path": "/f/q4GU4pdHTKjsGoQhAb7x/chart.png",
  "url": "https://artifacts.example.com/f/q4GU4pdHTKjsGoQhAb7x/chart.png",
  "preview_path": "/f/q4GU4pdHTKjsGoQhAb7x/chart.png?pt=…"
}
```

- Reference files from artifacts by `path` (relative), so links survive a domain change.
- The filename is sanitized to `[A-Za-z0-9_.-]`, and the MIME type is derived from the extension. The client's `Content-Type` is ignored.
- Files are public only while their artifact is published.
- `preview_path` carries a signed token that lets the editor preview load files of unpublished artifacts.

## Tokens (admin scope)

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/tokens` | | `[{id, name, prefix, scope, created_at, expires_at, last_used_at}]` |
| `POST` | `/api/tokens` | `{name, scope?: "publish"\|"admin", expires_in_days?: 1–3650}` | Create. The response contains `token`; it is shown only this once. |
| `DELETE` | `/api/tokens/:id` | | Revoke immediately |

Only the SHA-256 hash of a token is stored.

## Sessions and identity

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/whoami` | `{via: "bearer"\|"session", scope}` |
| `DELETE` | `/api/sessions` | Log out every browser session (admin scope) |
| `GET` | `/api/me` | Unauthenticated. `{authed, siteName, maxUploadMb}` for the UI. |
| `POST` | `/api/login` | `{token}`. Browser login; needs a same-origin `Origin` header. |
| `POST` | `/api/logout` | End the current browser session |

## Public routes

| Path | Description |
|---|---|
| `/a/:id` | Viewer page: title bar plus sandboxed iframe. Counts a view. Embeddable via `<iframe>`. |
| `/raw/:id` | Artifact document. Always served with `Content-Security-Policy: sandbox …`. |
| `/f/:id/:name` | Uploaded file. Supports `Range` requests. |
| `/healthz` | `{"ok": true}` |

## Artifact storage

Published HTML artifacts receive a frozen `window.artifactDB` client before their own scripts run. It writes JSON values to SQLite and works despite the artifact's opaque-origin sandbox.

```html
<script>
  // Private to this browser profile.
  await artifactDB.personal.set('drafts/welcome', { text: 'hello' });
  const draft = await artifactDB.personal.get('drafts/welcome');

  // Visible and writable to everyone who can open the artifact link.
  await artifactDB.shared.set('board/item-1', { title: 'First item' });
  const items = await artifactDB.shared.list('board/');
  await artifactDB.shared.delete('board/item-1');

  // Create-only write; rejects with HTTP 409 if the path exists.
  await artifactDB.shared.set('locks/once', true, { replace: false });
</script>
```

Each namespace exposes:

| Method | Result |
|---|---|
| `get(path)` | The decoded value, or `null` when absent |
| `set(path, data, {replace?: true})` | `{ok, path, updated_at}` |
| `delete(path)` | `{ok, deleted}` |
| `list(prefix = '', limit = 100)` | `[{path, data, updated_at}]`, ordered by path; limit 1–500 |

Paths are UTF-8 strings up to 512 bytes. Values can contain anything representable as JSON. The default limits are 1 MB per encoded value and 20 MB total per artifact, counting both namespaces.

The low-level endpoint is `POST /frame/db/:artifactId/call`, with the shape shown below. The viewer injects a signed, artifact-scoped token; app authors should use `artifactDB` instead of copying tokens from browser developer tools.

```json
{
  "token": "short-lived viewer capability",
  "scope": "personal",
  "verb": "set",
  "path": "drafts/welcome",
  "data": { "text": "hello" },
  "replace": true
}
```

- `personal` is keyed by a one-year, HttpOnly browser cookie. Clearing cookies creates a new identity; it is not an authenticated user account.
- `shared` is a collaborative namespace. Anyone with the artifact link can read and change it.
- Tokens expire after 24 hours and are renewed by reopening the viewer. They cannot access another artifact or the admin API.
- Unpublished artifacts cannot use storage. Their data is retained for republishing; deleting the artifact cascades to all of its stored data.

## Examples

```bash
H="Authorization: Bearer $ARTIFACT_SHARE_TOKEN"
URL=https://artifacts.example.com

# upload an image, then publish a page that uses it
FILE=$(curl -s -H "$H" --data-binary @chart.png "$URL/api/files?name=chart.png")
PATH_=$(jq -r .path <<<"$FILE"); ID=$(jq -r .id <<<"$FILE")
curl -s -H "$H" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$PATH_" --arg f "$ID" '{title: "Report", content: "<h1>Report</h1><img src=\"\($p)\">", files: [$f]}')" \
  "$URL/api/artifacts" | jq -r .url
```
