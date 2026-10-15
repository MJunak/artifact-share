# Development

## Layout

```
src/server.js        HTTP server, routing, auth, rendering, SQLite schema (single file)
public/              admin SPA (vanilla JS, no build step) + viewer assets
  index.html         templates for login, list, editor, tokens
  app.js / app.css   admin UI
  viewer.js/.css     public viewer page
  markdown.css       stylesheet for rendered Markdown (server + editor preview)
bin/artifact         Bash CLI
test/                node:test suites + smoke.sh for deployed instances
docs/                documentation
```

## Running locally

```bash
npm ci
ADMIN_TOKEN=$(openssl rand -base64 32) npm run dev    # restarts on file changes
```

## Tests

```bash
npm test            # node --test, no extra dependencies
```

Each test file starts a real server process on a random port with a throwaway data directory (`test/helpers.js`).

| File | Covers |
|---|---|
| `test/api.test.js` | Artifacts, versions, rendering, files, static routes |
| `test/tokens.test.js` | API token lifecycle and scopes |
| `test/security.test.js` | One regression test per control in [security.md](security.md) |
| `test/cli.test.js` | `bin/artifact` end to end (skipped without curl/jq) |

Against a running deployment:

```bash
ADMIN_TOKEN=… test/smoke.sh https://artifacts.example.com
```

`smoke.sh` creates and deletes a test artifact and deliberately triggers the brute-force throttle. Your IP is locked out for one minute afterwards.

## Design decisions

- **No framework, no build.** The whole server is auditable in one file. The UI is plain DOM code without `innerHTML`, which keeps XSS review simple.
- **`node:sqlite`.** No native module to compile, and backups are a single file.
- **Sandbox over sanitizing.** Artifacts are meant to run arbitrary JS, so the app isolates them instead of filtering HTML. Markdown is not sanitized for the same reason: it renders inside the same sandbox.
- **Opaque origin by default.** A separate content domain is better but needs DNS and certificates. The default must be safe on a single hostname.
