# Mastra adapter

This package exposes artifact-share as native [Mastra](https://mastra.ai) tools and, optionally, as a Mastra `MCPServer`.

## Configuration

Create a dedicated artifact-share API token with the `publish` scope. Keep it in the server-side environment; never put it in prompts, tool arguments, browser code, or model output.

```dotenv
ARTIFACT_SHARE_URL=https://artifacts-admin.example.com
ARTIFACT_SHARE_TOKEN=as_...
```

When `ADMIN_URL` is enabled, `ARTIFACT_SHARE_URL` must point to that private admin/API origin, not the public viewer origin.

## Native Mastra tools

```ts
import { Agent } from '@mastra/core/agent'
import { createArtifactShareTools } from 'artifact-share-mastra'

export const publishingAgent = new Agent({
  id: 'publishing-agent',
  name: 'Publishing agent',
  instructions: 'Publish reviewed HTML or Markdown artifacts when asked.',
  model: 'openai/gpt-5-mini',
  tools: createArtifactShareTools({
    requireWriteApproval: true,
    requireDeleteApproval: true,
  }),
})
```

The adapter provides `listArtifacts`, `getArtifact`, `publishArtifact`, `updateArtifact`, and `deleteArtifact`. Deletion requires approval by default.

## MCP server inside a Mastra application

```ts
import { Mastra } from '@mastra/core'
import { createArtifactShareMcpServer } from 'artifact-share-mastra'

export const mastra = new Mastra({
  mcpServers: {
    artifactShare: createArtifactShareMcpServer({
      requireWriteApproval: true,
      requireDeleteApproval: true,
    }),
  },
})
```

Mastra registers both MCP transport routes and REST inspection/execution routes. Protect the entire Mastra server with authentication; do not protect only the MCP transport path. For a company deployment, validate token audience and expiry, authorize every tool invocation, and resolve the user or tenant from trusted request context rather than model-supplied arguments.

## Deployment model

Recommended first rollout:

1. Run artifact-share as a private service with its own SQLite volume and backup.
2. Give the Mastra deployment one dedicated `publish` token through its secret store.
3. Import the native tools into the internal agent; enable approval for writes during the pilot.
4. Add the MCP server only when non-Mastra clients need the same capabilities.

artifact-share 0.4 is intentionally single-admin and not tenant-aware. A shared service token means all callers see the same artifact catalog. For sensitive or multi-team use, deploy one instance per trust boundary or add SSO/RBAC and tenant scoping before a broad rollout. The `personal` artifact database identifies a browser profile, not an employee account; `shared` data is writable by anyone with the artifact link.
