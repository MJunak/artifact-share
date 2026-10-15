---
name: artifact-share
description: "Publish, update, withdraw and delete shareable HTML/Markdown pages (artifacts) with images on the self-hosted artifact-share server, and manage its API tokens."
homepage: https://github.com/MJunak/artifact-share
metadata:
  {
    "openclaw":
      {
        "emoji": "🔗",
        "primaryEnv": "ARTIFACT_SHARE_TOKEN",
        "requires": { "bins": ["bash", "curl", "jq"], "env": ["ARTIFACT_SHARE_URL", "ARTIFACT_SHARE_TOKEN"] },
      },
  }
---

# artifact-share

artifact-share hosts HTML and Markdown pages ("artifacts") under unguessable links such as `https://…/a/Xk3pQ9vT2mLbHa`.
Anyone with the link can open a published artifact; there is no public index. Use this skill when the user wants to:

- turn a report, table, chart, summary or mini web app into a **shareable link**,
- update, withdraw (unpublish), restore or delete an existing artifact,
- upload images or files for a page,
- create, list or revoke **API tokens** for other people, scripts or machines.
- publish interactive apps whose form data persists through the built-in artifact database.

All operations go through the CLI `{baseDir}/artifact` (Bash + curl + jq). `ARTIFACT_SHARE_URL` and `ARTIFACT_SHARE_TOKEN` are injected by OpenClaw; never ask the user for them and never print `ARTIFACT_SHARE_TOKEN`.

## Commands

```bash
A={baseDir}/artifact

$A list                                          # id  vN  views  public|draft  title  url   (TSV)
$A get <id>                                      # metadata JSON
$A cat <id>                                      # current source
$A publish <file|-> [--title T] [--description D] [--kind html|markdown] [--draft]
$A update <id> [<file|->] [--title T] [--description D] [--publish|--unpublish]
$A versions <id>
$A delete <id>                                   # also deletes its files

$A upload <file> --artifact <id>                 # -> {path, url, …}
$A files [<id>]
$A rm-file <file-id>

$A tokens                                        # admin scope
$A token-create <name> [--scope publish|admin] [--days N]
$A token-revoke <token-id>
$A logout-all                                    # ends every browser session of the web UI
$A whoami
```

`publish` prints `url<TAB>id<TAB>vN`. Always give the user the **url**.

## Workflows

### Publish a page

1. Write a **self-contained** HTML document to a temp file (inline CSS and JS; CDN scripts from cdnjs/jsdelivr are fine). For prose, Markdown is fine and gets a clean default stylesheet.
2. `$A publish /tmp/page.html --title "…" --description "one sentence for link previews"`
3. Reply with the link.

Artifacts run in a sandbox without `localStorage`, cookies or access to the parent page; wrap any storage access in `try/catch`.

For persistent inputs, use the injected database client from artifact JavaScript:

```js
await artifactDB.personal.set('form/current', formData); // private to one browser profile
const saved = await artifactDB.personal.get('form/current');

await artifactDB.shared.set('items/42', item);           // shared by everyone with the link
const items = await artifactDB.shared.list('items/');
await artifactDB.shared.delete('items/42');
```

Use `personal` by default. Use `shared` only when the user explicitly wants collaboration, because anyone with the artifact link can read and change shared values. Storage accepts JSON-compatible data, defaults to 20 MB total per artifact, and works only while the artifact is published. A viewer cookie identifies a browser profile; it is not a login and clearing cookies starts a new personal namespace. Never copy or expose the short-lived frame token.

### Page with images

1. Create the artifact first (as a draft if images are missing): `id=$($A publish /tmp/page.html --draft | cut -f2)`
2. Upload each image: `$A upload chart.png --artifact "$id" | jq -r .path` gives `/f/<fileid>/chart.png`.
3. Reference that **relative path** in the HTML (`<img src="/f/…/chart.png">`) or Markdown (`![alt](/f/…/chart.png)`).
4. `$A update "$id" /tmp/page.html --publish`

Files of unpublished artifacts are not publicly reachable.

### Change an existing artifact

Find it with `$A list` (match by title), read it with `$A cat <id>`, edit, then `$A update <id> /tmp/page.html`. Every content change creates a new version; the link stays the same.

### Withdraw or delete

- "Take it offline", "hide it", "stop sharing": `$A update <id> --unpublish`. This is reversible; the link returns 404.
- "Delete": `$A delete <id>`. This is **irreversible** and also removes its versions and files. **Ask for confirmation first**, naming the title.

### Tokens

- For a person or script that only publishes: `$A token-create "<who/what>" --scope publish --days 90`.
- Use `--scope admin` only if the user explicitly asks for token-management rights.
- The token is printed **once**. Give it to the user exactly once and tell them to store it. Never repeat it later; it cannot be retrieved.
- Revoking (`token-revoke`) takes effect immediately. **Confirm first**, naming the token.
- `$A tokens` shows prefixes, scopes, last use and expiry, never the secret.
- Never create, reveal or revoke the token OpenClaw itself uses (named `openclaw`) unless the user explicitly asks.

## Rules

- Published artifacts are reachable by anyone with the link. Before publishing anything that looks private (personal data, credentials, customer data, internal finance), ask the user, or publish with `--draft`.
- Confirm before `delete`, `rm-file`, `token-revoke` and `logout-all`.
- On `error 401` the skill's token is invalid or revoked; on `error 429` wait a minute. Report it, don't retry in a loop.
- The web UI is at `$ARTIFACT_SHARE_URL/` (login with the admin token) if the user wants to edit by hand.
