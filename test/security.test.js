// Regression tests for the security review findings. Each test names the attack it guards against.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, runServerExpectingExit, client, bearer, loginSession, ADMIN_TOKEN, PNG } from './helpers.js';

let srv, admin, anon;

before(async () => {
  srv = await startServer();
  admin = client(srv.base, bearer(ADMIN_TOKEN));
  anon = client(srv.base);
});
after(() => srv.stop());

// --- Startup guards ------------------------------------------------------------

test('refuses to start with a weak ADMIN_TOKEN', async () => {
  const { code, output } = await runServerExpectingExit({ ADMIN_TOKEN: 'short' });
  assert.equal(code, 1);
  assert.match(output, /at least 32/);
});

test('refuses a CONTENT_URL on a sibling subdomain (same-site cookie tossing)', async () => {
  const { code, output } = await runServerExpectingExit({
    ADMIN_TOKEN, PUBLIC_URL: 'https://artifacts.example.com', CONTENT_URL: 'https://content.example.com',
  });
  assert.equal(code, 1);
  assert.match(output, /different registrable domain/);
});

// --- Visibility -----------------------------------------------------------------

test('anonymous users cannot list or read via the API', async () => {
  assert.equal((await anon.get('/api/artifacts')).status, 401);
  assert.equal((await anon.get('/api/files')).status, 401);
});

test('unpublished artifacts and their files are hidden', async () => {
  const up = await admin.post('/api/files?name=secret.png', PNG);
  const { data: a } = await admin.post('/api/artifacts', { content: 'draft', published: false, files: [up.data.id] });
  assert.equal((await anon.get(`/a/${a.id}`)).status, 404);
  assert.equal((await anon.get(`/raw/${a.id}`)).status, 404);
  assert.equal((await anon.get(up.data.path)).status, 404);
  assert.equal((await anon.get(up.data.preview_path)).status, 200, 'signed preview URL works without cookie');
  assert.equal((await anon.get(`${up.data.path}?pt=${'A'.repeat(32)}`)).status, 404, 'forged preview token');

  await admin.put(`/api/artifacts/${a.id}`, { published: true });
  assert.equal((await anon.get(up.data.path)).status, 200);
});

test('no path traversal and no admin shell under /static', async () => {
  for (const p of ['/static/index.html', '/static/../src/server.js', '/static/%2e%2e/src/server.js', '/static/..%2fsrc%2fserver.js']) {
    const r = await anon.get(p);
    assert.equal(r.status, 404, p);
  }
});

// --- Login --------------------------------------------------------------------

test('login rejects oversized bodies before parsing (memory DoS)', async () => {
  const r = await anon.post('/api/login', 'x'.repeat(100_000), {
    headers: { 'Content-Type': 'application/json', Origin: srv.base },
  });
  assert.equal(r.status, 413);
});

test('login requires JSON and a same-origin Origin header (login CSRF)', async () => {
  const body = JSON.stringify({ token: ADMIN_TOKEN });
  assert.equal((await anon.post('/api/login', body, { headers: { 'Content-Type': 'text/plain', Origin: srv.base } })).status, 415);
  assert.equal((await anon.post('/api/login', body, { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await anon.post('/api/login', body, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' } })).status, 403);
});

test('session cookie flags', async () => {
  const res = await fetch(`${srv.base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.base },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
});

// --- Session / CSRF -------------------------------------------------------------

test('cookie-authenticated writes need same origin', async () => {
  const { cookie } = await loginSession(srv.base);
  const json = { 'Content-Type': 'application/json' };
  const post = (headers) => anon.post('/api/artifacts', { content: 'x' }, { headers: { Cookie: cookie, ...json, ...headers } });

  assert.equal((await post({})).status, 403, 'missing Origin');
  assert.equal((await post({ Origin: 'https://evil.test' })).status, 403, 'foreign Origin');
  assert.equal((await post({ Origin: 'null' })).status, 403, 'sandboxed iframe');
  assert.equal((await post({ Origin: srv.base, 'Sec-Fetch-Site': 'same-site' })).status, 403, 'sibling subdomain');
  assert.equal((await post({ Origin: srv.base, 'Sec-Fetch-Site': 'same-origin' })).status, 201);
  assert.equal((await anon.get('/api/artifacts', { headers: { Cookie: cookie } })).status, 200, 'reads need no Origin');
});

test('a non-Bearer Authorization header never falls back to the cookie (CSRF bypass)', async () => {
  const { cookie } = await loginSession(srv.base);
  const r = await anon.post('/api/artifacts', { content: 'x' }, {
    headers: { Cookie: cookie, Authorization: 'Basic Zm9vOmJhcg==', Origin: 'https://evil.test' },
  });
  assert.equal(r.status, 401);
});

test('cookie-authenticated writes must be JSON (form-based CSRF)', async () => {
  const { cookie } = await loginSession(srv.base);
  const r = await anon.post('/api/artifacts', '{"content":"x"}', {
    headers: { Cookie: cookie, 'Content-Type': 'text/plain', Origin: srv.base, 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(r.status, 415);
});

test('malformed or duplicate cookies do not crash auth (cookie tossing)', async () => {
  const r = await anon.get('/api/me', { headers: { Cookie: 'x=%E0; as_session=%E0; as_session=junk' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.authed, false);
});

test('logout invalidates the session server-side', async () => {
  const { cookie, client: session } = await loginSession(srv.base);
  assert.equal((await session.post('/api/logout')).status, 200);
  assert.equal((await anon.get('/api/artifacts', { headers: { Cookie: cookie } })).status, 401);
});

test('revoking all sessions logs every browser out', async () => {
  const { cookie } = await loginSession(srv.base);
  assert.equal((await admin.del('/api/sessions')).status, 200);
  assert.equal((await anon.get('/api/artifacts', { headers: { Cookie: cookie } })).status, 401);
});

// --- Isolation of artifact content ------------------------------------------------

test('raw artifacts always run in an opaque-origin sandbox', async () => {
  const { data: a } = await admin.post('/api/artifacts', { content: '<script>fetch("/api/artifacts")</script>' });
  const r = await anon.get(`/raw/${a.id}`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /frame-ancestors/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('uploaded files cannot execute (SVG / HTML XSS)', async () => {
  const svg = await admin.post('/api/files?name=x.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const { data: a } = await admin.post('/api/artifacts', { content: 'x', files: [svg.data.id] });
  const r = await anon.get(svg.data.path);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

  const html = await admin.post(`/api/files?name=x.html&artifact=${a.id}`, '<script>alert(1)</script>');
  const h = await anon.get(html.data.path);
  assert.match(h.headers.get('content-disposition'), /^attachment/);

  const noext = await admin.post(`/api/files?name=noext&artifact=${a.id}`, '<script>alert(1)</script>', { headers: { 'Content-Type': 'text/html' } });
  assert.equal(noext.data.mime, 'application/octet-stream', 'client Content-Type is ignored');
});

test('admin UI is not framable; viewer is', async () => {
  const ui = await anon.get('/');
  assert.equal(ui.headers.get('x-frame-options'), 'DENY');
  assert.match(ui.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const { data: a } = await admin.post('/api/artifacts', { content: 'x' });
  const viewer = await anon.get(`/a/${a.id}`);
  assert.equal(viewer.headers.get('x-frame-options'), null);
});

test('Host header is not reflected into the page (cache poisoning / XSS)', async () => {
  const { data: a } = await admin.post('/api/artifacts', { content: 'x' });
  // fetch() refuses to override Host, so send the raw request with node:http.
  const body = await new Promise((resolve, reject) => {
    const req = http.request(`${srv.base}/a/${a.id}`, { headers: { Host: 'evil.test"><script>alert(1)</script>' } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
  assert.match(body, /<iframe/, 'request reached the viewer');
  assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
});

// --- Brute force (separate instance so throttling does not affect other tests) -----

test('failed Bearer attempts are throttled per client', async () => {
  const s = await startServer();
  try {
    const wrong = client(s.base, bearer('wrong-token'));
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await wrong.get('/api/artifacts')).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.equal(statuses[11], 429);
    // While throttled, even the right token is refused, so guesses reveal nothing.
    assert.equal((await client(s.base, bearer(ADMIN_TOKEN)).get('/api/artifacts')).status, 429);
  } finally {
    await s.stop();
  }
});

test('failed logins are throttled', async () => {
  const s = await startServer();
  try {
    const c = client(s.base);
    let last;
    for (let i = 0; i < 12; i++) {
      last = await c.post('/api/login', { token: 'nope' }, { headers: { Origin: s.base } });
    }
    assert.equal(last.status, 429);
  } finally {
    await s.stop();
  }
});

test('X-Forwarded-For is ignored unless TRUST_PROXY is set (rate-limit bypass)', async () => {
  const s = await startServer();
  try {
    let last;
    for (let i = 0; i < 12; i++) {
      last = await client(s.base, { headers: { Authorization: 'Bearer wrong', 'X-Forwarded-For': `10.0.0.${i}` } }).get('/api/artifacts');
    }
    assert.equal(last.status, 429);
  } finally {
    await s.stop();
  }
});
