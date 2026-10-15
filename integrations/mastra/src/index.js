import { createTool } from '@mastra/core/tools';
import { MCPServer } from '@mastra/mcp';
import { z } from 'zod';

const artifactSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(['html', 'markdown']),
  version: z.number(),
  published: z.boolean(),
  views: z.number(),
  size: z.number(),
  created_at: z.number(),
  updated_at: z.number(),
  url: z.string(),
});

const artifactSchema = artifactSummarySchema.extend({ content: z.string() });

export class ArtifactShareError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'ArtifactShareError';
    this.status = status;
    this.body = body;
  }
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

export function createArtifactShareClient(options = {}) {
  const baseUrl = required(options.baseUrl ?? process.env.ARTIFACT_SHARE_URL, 'ARTIFACT_SHARE_URL').replace(/\/+$/, '');
  const token = required(options.token ?? process.env.ARTIFACT_SHARE_TOKEN, 'ARTIFACT_SHARE_TOKEN');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

  async function request(path, { method = 'GET', body, signal } = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error || `artifact-share request failed with HTTP ${response.status}`;
      throw new ArtifactShareError(message, { status: response.status, body: payload });
    }
    return payload;
  }

  return Object.freeze({
    listArtifacts: ({ signal } = {}) => request('/api/artifacts', { signal }),
    getArtifact: (id, { signal } = {}) => request(`/api/artifacts/${encodeURIComponent(id)}`, { signal }),
    createArtifact: (input, { signal } = {}) => request('/api/artifacts', { method: 'POST', body: input, signal }),
    updateArtifact: (id, input, { signal } = {}) => request(`/api/artifacts/${encodeURIComponent(id)}`, { method: 'PATCH', body: input, signal }),
    deleteArtifact: (id, { signal } = {}) => request(`/api/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE', signal }),
    listVersions: (id, { signal } = {}) => request(`/api/artifacts/${encodeURIComponent(id)}/versions`, { signal }),
    getVersion: (id, version, { signal } = {}) => request(`/api/artifacts/${encodeURIComponent(id)}/versions/${version}`, { signal }),
  });
}

export function createArtifactShareTools(options = {}) {
  const client = options.client ?? createArtifactShareClient(options);
  const requireWriteApproval = options.requireWriteApproval ?? false;
  const requireDeleteApproval = options.requireDeleteApproval ?? true;
  const signalFrom = (context) => context?.abortSignal;

  return {
    listArtifacts: createTool({
      id: 'artifact-share-list',
      description: 'List artifacts without returning their full HTML or Markdown content.',
      inputSchema: z.object({}),
      outputSchema: z.array(artifactSummarySchema),
      execute: async (_input, context) => client.listArtifacts({ signal: signalFrom(context) }),
    }),
    getArtifact: createTool({
      id: 'artifact-share-get',
      description: 'Read one artifact, including its HTML or Markdown content.',
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: artifactSchema,
      execute: async ({ id }, context) => client.getArtifact(id, { signal: signalFrom(context) }),
    }),
    publishArtifact: createTool({
      id: 'artifact-share-publish',
      description: 'Create a new HTML or Markdown artifact and return its shareable URL.',
      inputSchema: z.object({
        title: z.string().max(200).optional(),
        description: z.string().max(500).optional(),
        kind: z.enum(['html', 'markdown']).default('html'),
        content: z.string().min(1),
        published: z.boolean().default(true),
      }),
      outputSchema: artifactSchema,
      requireApproval: requireWriteApproval,
      execute: async (input, context) => client.createArtifact(input, { signal: signalFrom(context) }),
    }),
    updateArtifact: createTool({
      id: 'artifact-share-update',
      description: 'Update the title, description, kind, content, or publication state of an existing artifact.',
      inputSchema: z.object({
        id: z.string().min(1),
        title: z.string().max(200).optional(),
        description: z.string().max(500).optional(),
        kind: z.enum(['html', 'markdown']).optional(),
        content: z.string().min(1).optional(),
        published: z.boolean().optional(),
      }),
      outputSchema: artifactSchema,
      requireApproval: requireWriteApproval,
      execute: async ({ id, ...input }, context) => client.updateArtifact(id, input, { signal: signalFrom(context) }),
    }),
    deleteArtifact: createTool({
      id: 'artifact-share-delete',
      description: 'Permanently delete an artifact, its versions, files, and stored app data.',
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: z.object({ ok: z.boolean() }),
      requireApproval: requireDeleteApproval,
      execute: async ({ id }, context) => client.deleteArtifact(id, { signal: signalFrom(context) }),
    }),
  };
}

export function createArtifactShareMcpServer(options = {}) {
  return new MCPServer({
    id: options.id ?? 'artifact-share',
    name: options.name ?? 'Artifact Share',
    version: options.version ?? '0.1.0',
    tools: createArtifactShareTools(options),
  });
}
