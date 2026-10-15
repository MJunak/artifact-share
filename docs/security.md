# Security model

artifact-share serves **arbitrary, possibly hostile HTML and JavaScript** to anonymous visitors from the same server that hosts an admin UI. Everything below follows from that.

## Assets and actors

| Asset | Must not happen |
|---|---|
| Admin session and tokens | Theft, or use by anyone but the admin |
| Unpublished artifacts and their files | Reading by anonymous users |
| Artifact list | Enumeration by anonymous users |
| Personal artifact data | Reading by a different browser identity or artifact |
| The service | Taken down by unauthenticated requests |

| Actor | Capabilities |
|---|---|
| Anonymous visitor | Any HTTP request to any route, any headers |
| Hostile artifact | JavaScript running in a visitor's or the admin's browser via `/a/:id`, `/raw/:id` or the editor preview |
| Holder of a `publish` token | Full control over artifacts and files, nothing else |

## Controls

### 1. Artifact code never runs with the app's origin

- `/raw/:id` is always sent with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups …`, **without** `allow-same-origin`. The document gets an opaque origin, even when opened directly in a tab rather than through the viewer's iframe.
- The viewer's `<iframe>` repeats the same `sandbox` attribute.
- The editor preview is a `srcdoc` iframe with `sandbox` and without `allow-same-origin`.
- Consequence: artifact scripts cannot read the admin DOM or cookies, and their requests carry `Origin: null`, so the CSRF check rejects them. `localStorage` is not available to artifacts in this mode.
- `frame-ancestors` limits who may frame `/raw/:id`. The admin UI sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`. The viewer `/a/:id` stays embeddable on purpose.

### 2. Sessions

- The session ID is 256 random bits, stored server-side as a SHA-256 hash, so logout and "log out everywhere" really revoke it.
- The cookie is `HttpOnly; SameSite=Strict; Secure` (over HTTPS) and named `__Host-as_session`. The `__Host-` prefix stops sibling subdomains from overwriting or shadowing it.
- Malformed cookies are ignored instead of failing the request. If a cookie name appears twice, the first occurrence wins.

### 3. CSRF

Cookie-authenticated writes must satisfy all of the following:

- `Origin` equals `PUBLIC_URL`. A missing Origin or `null` is rejected.
- `Sec-Fetch-Site`, when the browser sends it, is `same-origin`. `same-site` is rejected.
- `Content-Type: application/json`, which forces a CORS preflight, so HTML forms cannot forge requests.

Any `Authorization` header disables the cookie entirely. Basic or NTLM credentials that a browser attaches automatically therefore cannot smuggle a cookie past the Origin check.

### 4. Tokens and brute force

- `ADMIN_TOKEN` must be at least 32 characters, and the server refuses to start otherwise.
- Comparison is constant-time on SHA-256 digests, so it leaks neither length nor prefix.
- API tokens carry about 234 bits of randomness and are stored as SHA-256. `publish` tokens cannot create tokens, so a leaked CI token cannot escalate.
- Failed authentication (login and Bearer) is throttled at 10 per client per minute, plus a global cap of 300 per minute. While a client is throttled, even a correct guess gets `429`.
- Client IPs come from the socket, and `X-Forwarded-For` is honoured only with `TRUST_PROXY=true`, using its right-most entry.
- The login body is capped at 4 KB before parsing.

### 5. Uploads

- The MIME type is derived from the file extension. The client's `Content-Type` is ignored.
- Every file response carries `Content-Security-Policy: default-src 'none'; …; sandbox` and `X-Content-Type-Options: nosniff`, so SVG scripts and HTML files cannot execute on the app origin.
- HTML, XML and unknown types are sent as `attachment`.
- Filenames are reduced to `[A-Za-z0-9_.-]`, which prevents header injection.
- Files are served only while their artifact is published. Drafts need a session or a signed preview token (HMAC). The shared cache lifetime is 5 minutes, so withdrawing an artifact takes effect quickly.

### 6. Artifact storage

- The viewer mints a 24-hour HMAC capability containing exactly one artifact ID and one pseudonymous viewer ID. The capability cannot authenticate to `/api/*` or another artifact.
- The storage endpoint accepts the capability in the JSON body and explicitly allows the sandbox's opaque `Origin: null`; it never uses the admin session cookie.
- `personal` rows are partitioned by the viewer ID. The ID lives in a one-year `HttpOnly; SameSite=Lax; Secure` (over HTTPS) `__Host-as_viewer` cookie on the public host. This is browser-profile isolation, not account authentication.
- `shared` rows deliberately use one namespace for everyone with the link. Do not store secrets there.
- JSON values are capped per entry and per artifact. Paths are bounded, SQL is prepared, unpublished artifacts reject calls, and artifact deletion cascades to its stored rows.
- Values are stored as plaintext JSON inside `artifacts.db`; filesystem access and backups must be protected accordingly.

### 7. Input handling

- All SQL uses prepared statements, and IDs must match `\w+`.
- Static files come from an allowlist, which rules out path traversal.
- Absolute URLs come from `PUBLIC_URL`, never from the `Host` header, which prevents cache poisoning and reflected XSS.
- Titles and descriptions are HTML-escaped on the server. The admin UI builds its DOM without `innerHTML`.

### 8. Optional admin/public split

With `ADMIN_URL`, the admin UI and `/api/*` answer only on that host, and the session cookie and CSRF origin belong to it. A public hostname serves only `/a/`, `/raw/`, `/f/`, capability-protected `/frame/db/`, `/static/` and `/healthz`, so neither the login form nor the admin API is reachable from the internet. That removes the main target for brute force and phishing.

### 9. Runtime

- The container runs as non-root on a read-only root filesystem, with all capabilities dropped and `no-new-privileges` set.
- Memory and PIDs are limited.
- Request headers must arrive within 20 s.

## Separate content origin

Without `CONTENT_URL`, artifacts cannot use `localStorage`, IndexedDB or cookies. With it, they run on their own origin and get those APIs back. **Choose the domain carefully:**

- **Use a different registrable domain** (`example-usercontent.com` next to `artifacts.example.com`). Browsers treat everything under one registrable domain as *same-site*. On a sibling subdomain a hostile artifact could:
  - set cookies on the parent domain ("cookie tossing") and break or shadow sessions of **every** service under that domain,
  - pass `SameSite` checks.

  The server refuses to start with a sibling subdomain.
- All artifacts share that one content origin, so they can read each other's `localStorage`. Don't let artifacts store secrets there.

## Known limitations

- **Single admin.** There is no per-user access control. Everyone with a session or an `admin` token can do everything.
- **Links are capabilities.** Anyone who has an artifact link can view it and forward it. Unpublish to revoke.
- **Personal storage is device-scoped.** Clearing the viewer cookie loses access to that namespace and creates a new one. The service administrator can access the SQLite database.
- **Shared storage is link-scoped.** Anyone with the link can read, overwrite or delete shared entries; it is collaboration, not authorization.
- **Phishing inside artifacts.** A hostile artifact can draw a fake login form inside its frame. It cannot read the real session.
- **View counts** can be inflated by anyone.

## Verification

`npm test` contains a regression test for every control above ([`test/security.test.js`](../test/security.test.js)). [`test/smoke.sh`](../test/smoke.sh) runs a subset against a deployed instance.
