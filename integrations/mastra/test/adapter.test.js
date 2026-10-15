import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createArtifactShareClient, createArtifactShareMcpServer, createArtifactShareTools } from '../src/index.js';

let server;
let baseUrl;
const calls = [];

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/artifacts' && req.method === 'GET') return res.end('[]');
    if (req.url === '/api/artifacts' && req.method === 'POST') {
      res.statusCode = 201;
      return res.end(JSON.stringify({ id: 'abc', title: 'Test', description: '', kind: 'markdown', version: 1, published: true, views: 0, size: 4, created_at: 1, updated_at: 1, url: 'https://example.test/a/abc', content: 'Test' }));
    }
    if (req.url === '/api/artifacts/missing') {
      res.statusCode = 404;
      return res.end('{"error":"Not found"}');
    }
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('client authenticates and maps artifact operations', async () => {
  const client = createArtifactShareClient({ baseUrl: `${baseUrl}/`, token: 'as_test' });
  assert.deepEqual(await client.listArtifacts(), []);
  const created = await client.createArtifact({ kind: 'markdown', content: 'Test' });
  assert.equal(created.id, 'abc');
  assert.deepEqual(calls.slice(-2).map((call) => [call.method, call.url, call.authorization]), [
    ['GET', '/api/artifacts', 'Bearer as_test'],
    ['POST', '/api/artifacts', 'Bearer as_test'],
  ]);
});

test('client returns bounded HTTP errors without exposing credentials', async () => {
  const client = createArtifactShareClient({ baseUrl, token: 'as_secret_value' });
  await assert.rejects(() => client.getArtifact('missing'), (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.message, 'Not found');
    assert.equal(String(error).includes('as_secret_value'), false);
    return true;
  });
});

test('factory exposes native Mastra tools and an MCP server', () => {
  const client = createArtifactShareClient({ baseUrl, token: 'as_test' });
  const tools = createArtifactShareTools({ client });
  assert.deepEqual(Object.keys(tools), ['listArtifacts', 'getArtifact', 'publishArtifact', 'updateArtifact', 'deleteArtifact']);
  const mcp = createArtifactShareMcpServer({ client });
  assert.equal(mcp.id, 'artifact-share');
});
