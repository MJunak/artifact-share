// PUBLIC_URL (share links) on a public hostname, ADMIN_URL (UI + API) on a private one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, runServerExpectingExit, client, bearer, ADMIN_TOKEN } from './helpers.js';

const PUBLIC = 'https://share.example.com';
let srv, admin, adminUrl;

// fetch() cannot override Host, so requests "from the public hostname" go through node:http.
function requestAs(host, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${srv.base}${path}`, { method, headers: { Host: host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  srv = await startServer((port) => {
    adminUrl = `http://127.0.0.1:${port}`;
    return { PUBLIC_URL: PUBLIC, ADMIN_URL: adminUrl, TRUST_PROXY: 'true' };
  });
  admin = client(srv.base, bearer(ADMIN_TOKEN));
});
after(() => srv.stop());

test('share links use PUBLIC_URL', async () => {
  const { data } = await admin.post('/api/artifacts', { content: 'x' });
  assert.equal(data.url, `${PUBLIC}/a/${data.id}`);
});

test('admin UI and API are not served on the public hostname', async () => {
  for (const p of ['/', '/new', '/tokens', '/edit/abc', '/api/me', '/api/artifacts']) {
    assert.equal((await requestAs('share.example.com', p)).status, 404, p);
  }
  const login = await requestAs('share.example.com', '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: PUBLIC },
  });
  assert.equal(login.status, 404);
});

test('public routes work on the public hostname', async () => {
  const { data } = await admin.post('/api/artifacts', { content: '<p>hi</p>' });
  assert.equal((await requestAs('share.example.com', `/a/${data.id}`)).status, 200);
  assert.equal((await requestAs('share.example.com', `/raw/${data.id}`)).status, 200);
  assert.equal((await requestAs('share.example.com', `/frame/db/${data.id}/call`, { method: 'OPTIONS' })).status, 204);
  assert.equal((await requestAs('share.example.com', '/static/viewer.css')).status, 200);
  assert.equal((await requestAs('share.example.com', '/healthz')).status, 200);
});

test('raw content may be framed by both origins', async () => {
  const { data } = await admin.post('/api/artifacts', { content: 'x' });
  const r = await requestAs('share.example.com', `/raw/${data.id}`);
  assert.match(r.headers['content-security-policy'], new RegExp(`frame-ancestors 'self' ${PUBLIC} ${adminUrl}`));
});

test('browser login works on the admin origin, CSRF checks the admin origin', async () => {
  const ok = await fetch(`${srv.base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: adminUrl }, body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const fromPublic = await fetch(`${srv.base}/api/artifacts`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: PUBLIC }, body: '{"content":"x"}',
  });
  assert.equal(fromPublic.status, 403, 'Origin of the public site is not accepted for cookie writes');
});

test('ADMIN_URL needs PUBLIC_URL; CONTENT_URL must not be same-site with ADMIN_URL', async () => {
  assert.match((await runServerExpectingExit({ ADMIN_TOKEN, ADMIN_URL: 'https://a.example.com' })).output, /requires PUBLIC_URL/);
  const r = await runServerExpectingExit({
    ADMIN_TOKEN, PUBLIC_URL: 'https://share.other.org', ADMIN_URL: 'https://admin.example.com', CONTENT_URL: 'https://c.example.com',
  });
  assert.match(r.output, /different registrable domain than ADMIN_URL/);
});
