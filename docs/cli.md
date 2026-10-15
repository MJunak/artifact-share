# CLI: `bin/artifact`

A single Bash script that wraps the [API](api.md). Needs `bash`, `curl` and `jq`.

```bash
install -m 755 bin/artifact ~/.local/bin/artifact
export ARTIFACT_SHARE_URL=https://artifacts.example.com
export ARTIFACT_SHARE_TOKEN=as_…        # create one under "API-Tokens"
artifact whoami
```

The token is passed to curl on stdin, never as a command-line argument, so it does not show up in `ps`.

## Commands

```text
artifact list                                   id, version, views, state, title, url (TSV)
artifact get <id>                               metadata as JSON
artifact cat <id>                               raw content, byte-exact
artifact publish <file|-> [--title T] [--description D] [--kind html|markdown] [--draft]
artifact update <id> [<file|->] [--title T] [--description D] [--kind K] [--publish|--unpublish]
artifact versions <id>
artifact delete <id>

artifact upload <file> [--artifact <id>]        prints {id, name, mime, size, path, url}
artifact files [<artifact-id>]
artifact rm-file <file-id>

artifact tokens                                 (admin scope)
artifact token-create <name> [--scope publish|admin] [--days N]
artifact token-revoke <token-id>
artifact logout-all
```

`kind` defaults to `markdown` for `.md`/`.markdown` files and to `html` otherwise. The title defaults to the file name without its extension.

## Recipes

Publish a page with an image:

```bash
img=$(artifact upload chart.png | jq -r .path)
id=$(printf '<h1>Q3</h1><img src="%s">' "$img" | artifact publish - --title "Q3" | cut -f2)
```

The upload above is not attached to an artifact yet. Attach it by re-uploading with `--artifact "$id"`, or use the API's `files` field on create. Unattached uploads are deleted after `ORPHAN_FILE_HOURS`.

Update from CI on every build:

```bash
artifact update "$REPORT_ID" build/report.html
```

Create a short-lived token for a teammate:

```bash
artifact token-create "laptop-anna" --scope publish --days 30
```
