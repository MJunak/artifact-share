import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, bearer, loginSession, ADMIN_TOKEN } from './helpers.js';

let srv, master, anon;

before(async () => {
  srv = await startServer();
  master = client(srv.base, bearer(ADMIN_TOKEN));
  anon = client(srv.base);
});
after(() => srv.stop());

test('create, use, list and revoke a publish token', async () => {
  const created = await master.post('/api/tokens', { name: 'ci' });
  assert.equal(created.status, 201);
  assert.match(created.data.token, /^as_[A-Za-z0-9]{40}$/);
  assert.equal(created.data.scope, 'publish');
  assert.equal(created.data.prefix, created.data.token.slice(0, 7));

  const ci = client(srv.base, bearer(created.data.token));
  assert.deepEqual((await ci.get('/api/whoami')).data, { via: 'bearer', scope: 'publish' });
  assert.equal((await ci.post('/api/artifacts', { content: 'from ci' })).status, 201);

  const list = await master.get('/api/tokens');
  const row = list.data.find((t) => t.id === created.data.id);
  assert.ok(row.last_used_at, 'last_used_at is tracked');
  assert.ok(!('token' in row) && !('token_hash' in row), 'secrets are never listed');

  assert.equal((await master.del(`/api/tokens/${created.data.id}`)).status, 200);
  assert.equal((await ci.get('/api/artifacts')).status, 401, 'revoked token stops working');
  assert.equal((await master.del(`/api/tokens/${created.data.id}`)).status, 404);
});

test('publish tokens cannot manage tokens or sessions', async () => {
  const { data } = await master.post('/api/tokens', { name: 'limited', scope: 'publish' });
  const limited = client(srv.base, bearer(data.token));
  assert.equal((await limited.get('/api/tokens')).status, 403);
  assert.equal((await limited.post('/api/tokens', { name: 'escalate', scope: 'admin' })).status, 403);
  assert.equal((await limited.del('/api/sessions')).status, 403);
});

test('admin tokens can manage tokens', async () => {
  const { data } = await master.post('/api/tokens', { name: 'openclaw', scope: 'admin' });
  const bot = client(srv.base, bearer(data.token));
  const child = await bot.post('/api/tokens', { name: 'child', expires_in_days: 30 });
  assert.equal(child.status, 201);
  assert.ok(child.data.expires_at > Date.now() + 29 * 86400_000);
});

test('token input validation', async () => {
  assert.equal((await master.post('/api/tokens', {})).status, 400);
  assert.equal((await master.post('/api/tokens', { name: 'x', scope: 'root' })).status, 400);
  assert.equal((await master.post('/api/tokens', { name: 'x', expires_in_days: 0 })).status, 400);
  assert.equal((await master.post('/api/tokens', { name: 'x', expires_in_days: 99999 })).status, 400);
});

test('the browser session can manage tokens', async () => {
  const { client: session } = await loginSession(srv.base);
  const created = await session.post('/api/tokens', { name: 'from-ui' });
  assert.equal(created.status, 201);
  assert.ok((await session.get('/api/tokens')).data.some((t) => t.name === 'from-ui'));
});

test('unknown tokens are rejected', async () => {
  assert.equal((await client(srv.base, bearer('as_' + 'x'.repeat(40))).get('/api/artifacts')).status, 401);
  assert.equal((await anon.get('/api/tokens')).status, 401);
});
