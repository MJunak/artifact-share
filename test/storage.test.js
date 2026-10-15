import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, bearer, ADMIN_TOKEN } from './helpers.js';

let srv, admin, anon;

before(async () => {
  srv = await startServer();
  admin = client(srv.base, bearer(ADMIN_TOKEN));
  anon = client(srv.base);
});
after(() => srv.stop());

function frameToken(viewerHtml) {
  const src = viewerHtml.match(/<iframe src="([^"]+)"/)?.[1];
  assert.ok(src, 'viewer contains an artifact frame');
  return new URL(src, srv.base).searchParams.get('ft');
}

const call = (artifactId, token, verb, path, data, extra = {}) =>
  anon.post(`/frame/db/${artifactId}/call`, { token, verb, path, ...(data === undefined ? {} : { data }), ...extra });

test('viewer supplies a scoped token and injects the storage client', async () => {
  const { data: artifact } = await admin.post('/api/artifacts', { content: '<script>window.ready=!!artifactDB</script>' });
  const viewer = await anon.get(`/a/${artifact.id}`);
  assert.match(viewer.headers.get('set-cookie'), /as_viewer=.*HttpOnly.*SameSite=Lax/);
  const token = frameToken(viewer.text);
  assert.match(token, /^fd1\./);

  const raw = await anon.get(`/raw/${artifact.id}?ft=${encodeURIComponent(token)}`);
  assert.match(raw.text, /Object\.defineProperty\(window,'artifactDB'/);
  assert.ok(raw.text.indexOf("'artifactDB'") < raw.text.indexOf('window.ready'), 'storage client loads before artifact scripts');
  assert.doesNotMatch((await anon.get(`/raw/${artifact.id}`)).text, /Object\.defineProperty\(window,'artifactDB'/);
});

test('storage bootstrap preserves a leading doctype when a document has no head', async () => {
  const { data: artifact } = await admin.post('/api/artifacts', { content: '<!doctype html><html><body>ok</body></html>' });
  const token = frameToken((await anon.get(`/a/${artifact.id}`)).text);
  const raw = await anon.get(`/raw/${artifact.id}?ft=${encodeURIComponent(token)}`);
  assert.match(raw.text, /^<!doctype html><html><script>/i);
});

test('personal values are isolated while shared values cross viewer identities', async () => {
  const { data: artifact } = await admin.post('/api/artifacts', { content: 'storage' });
  const tokenA = frameToken((await anon.get(`/a/${artifact.id}`)).text);
  const tokenB = frameToken((await anon.get(`/a/${artifact.id}`)).text);
  assert.notEqual(tokenA, tokenB);

  assert.equal((await call(artifact.id, tokenA, 'set', 'notes/1', { text: 'private' }, { scope: 'personal' })).status, 200);
  assert.deepEqual((await call(artifact.id, tokenA, 'get', 'notes/1', undefined, { scope: 'personal' })).data.data, { text: 'private' });
  assert.equal((await call(artifact.id, tokenB, 'get', 'notes/1', undefined, { scope: 'personal' })).data.found, false);

  await call(artifact.id, tokenA, 'set', 'board/1', ['shared'], { scope: 'shared' });
  assert.deepEqual((await call(artifact.id, tokenB, 'get', 'board/1', undefined, { scope: 'shared' })).data.data, ['shared']);
});

test('set, list and delete enforce expected semantics', async () => {
  const { data: artifact } = await admin.post('/api/artifacts', { content: 'storage' });
  const token = frameToken((await anon.get(`/a/${artifact.id}`)).text);

  assert.equal((await call(artifact.id, token, 'set', 'items/a', 1, { scope: 'shared', replace: false })).status, 200);
  assert.equal((await call(artifact.id, token, 'set', 'items/a', 2, { scope: 'shared', replace: false })).status, 409);
  await call(artifact.id, token, 'set', 'items/b', 2, { scope: 'shared' });
  await call(artifact.id, token, 'set', 'items/%literal', 3, { scope: 'shared' });

  const listed = await call(artifact.id, token, 'list', 'items/', undefined, { scope: 'shared', limit: 2 });
  assert.deepEqual(listed.data.items.map((item) => item.path), ['items/%literal', 'items/a']);
  const literal = await call(artifact.id, token, 'list', 'items/%', undefined, { scope: 'shared' });
  assert.deepEqual(literal.data.items.map((item) => item.path), ['items/%literal']);

  assert.equal((await call(artifact.id, token, 'delete', 'items/a', undefined, { scope: 'shared' })).data.deleted, true);
  assert.equal((await call(artifact.id, token, 'delete', 'items/a', undefined, { scope: 'shared' })).data.deleted, false);
});

test('tokens are artifact-scoped and storage follows publication state', async () => {
  const { data: first } = await admin.post('/api/artifacts', { content: 'first' });
  const { data: second } = await admin.post('/api/artifacts', { content: 'second' });
  const token = frameToken((await anon.get(`/a/${first.id}`)).text);

  assert.equal((await call(second.id, token, 'get', 'x')).status, 401);
  assert.equal((await call(first.id, token + 'x', 'get', 'x')).status, 401);
  await admin.put(`/api/artifacts/${first.id}`, { published: false });
  assert.equal((await call(first.id, token, 'get', 'x')).status, 404);
});

test('sandbox preflight receives narrowly scoped CORS headers', async () => {
  const { data: artifact } = await admin.post('/api/artifacts', { content: 'cors' });
  const response = await fetch(`${srv.base}/frame/db/${artifact.id}/call`, {
    method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(response.headers.get('access-control-allow-headers'), 'content-type');
});

test('artifact-wide quota includes personal and shared values', async () => {
  const limited = await startServer({ MAX_ARTIFACT_STORAGE_MB: '0.001', MAX_STORAGE_VALUE_MB: '0.001' });
  try {
    const root = client(limited.base, bearer(ADMIN_TOKEN));
    const guest = client(limited.base);
    const { data: artifact } = await root.post('/api/artifacts', { content: 'quota' });
    const html = (await guest.get(`/a/${artifact.id}`)).text;
    const src = html.match(/<iframe src="([^"]+)"/)[1];
    const token = new URL(src, limited.base).searchParams.get('ft');
    const endpoint = `/frame/db/${artifact.id}/call`;
    assert.equal((await guest.post(endpoint, { token, scope: 'personal', verb: 'set', path: 'a', data: 'x'.repeat(700) })).status, 200);
    assert.equal((await guest.post(endpoint, { token, scope: 'shared', verb: 'set', path: 'b', data: 'x'.repeat(700) })).status, 413);
  } finally {
    await limited.stop();
  }
});
