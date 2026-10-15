# OpenClaw skill

[`artifact-share/SKILL.md`](artifact-share/SKILL.md) lets an [OpenClaw](https://openclaw.ai) agent publish and maintain artifacts and manage API tokens through the [`bin/artifact`](../../bin/artifact) CLI.

## Install

```bash
SKILL=~/.openclaw/workspace/skills/artifact-share
mkdir -p "$SKILL"
cp integrations/openclaw/artifact-share/SKILL.md "$SKILL/"
install -m 755 bin/artifact "$SKILL/artifact"

# Dedicated token for the agent: admin scope only if it should manage tokens, otherwise publish.
TOKEN=$(ARTIFACT_SHARE_URL=https://artifacts.example.com ARTIFACT_SHARE_TOKEN=<admin token> \
  bin/artifact token-create openclaw --scope admin | jq -r .token)

openclaw config set skills.entries.artifact-share.env.ARTIFACT_SHARE_URL https://artifacts.example.com
openclaw config set skills.entries.artifact-share.apiKey "$TOKEN"
openclaw skills info artifact-share
```

`apiKey` is mapped to `ARTIFACT_SHARE_TOKEN` through `primaryEnv`. Skill env vars apply to host runs only; sandboxed agents need the variables passed into the sandbox separately.

## Update

Copy `SKILL.md` and `bin/artifact` again. The token stays in the OpenClaw config.

## Revoke

Revoke the `openclaw` token in the web UI under **API-Tokens**, or with `artifact token-revoke <id>`.
