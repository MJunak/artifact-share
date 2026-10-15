import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, bearer, ADMIN_TOKEN, PNG } from './helpers.js';

let srv, admin, anon;

before(async () => {
  srv = await startServer();
  admin = client(srv.base, bearer(ADMIN_TOKEN));
  anon = client(srv.base);
});
after(() => srv.stop());

test('health check', async () => {
  const r = await anon.get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
});

test('create, read, list an HTML artifact', async () => {
  const created = await admin.post('/api/artifacts', { title: 'Hello', description: 'desc', content: '<h1>Hi</h1>' });
  assert.equal(created.status, 201);
  assert.match(created.data.id, /^[A-Za-z0-9]{14}$/);
  assert.equal(created.data.version, 1);
  assert.equal(created.data.kind, 'html');
  assert.equal(created.data.published, true);
  assert.equal(created.data.url, `${srv.base}/a/${created.data.id}`);

  const got = await admin.get(`/api/artifacts/${created.data.id}`);
  assert.equal(got.data.content, '<h1>Hi</h1>');

  const list = await admin.get('/api/artifacts');
  assert.ok(list.data.some((a) => a.id === created.data.id));
  assert.ok(list.data.every((a) => !('content' in a)), 'list must not include content');
});

test('validation errors', async () => {
  assert.equal((await admin.post('/api/artifacts', { title: 'x' })).status, 400);
  assert.equal((await admin.post('/api/artifacts', { content: 'x', kind: 'pdf' })).status, 400);
  assert.equal((await admin.post('/api/artifacts', '{"content":', { headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await admin.get('/api/artifacts/doesnotexist')).status, 404);
  assert.equal((await admin.get('/api/nope')).status, 404);
});

test('updates create versions only when content changes', async () => {
  const { data: a } = await admin.post('/api/artifacts', { title: 'V', content: 'one' });
  const v2 = await admin.put(`/api/artifacts/${a.id}`, { content: 'two' });
  assert.equal(v2.data.version, 2);
  const same = await admin.put(`/api/artifacts/${a.id}`, { description: 'only metadata' });
  assert.equal(same.data.version, 2, 'description change keeps the version');

  const versions = await admin.get(`/api/artifacts/${a.id}/versions`);
  assert.deepEqual(versions.data.map((v) => v.version), [2, 1]);
  const v1 = await admin.get(`/api/artifacts/${a.id}/versions/1`);
  assert.equal(v1.data.content, 'one');
  assert.equal((await admin.get(`/api/artifacts/${a.id}/versions/9`)).status, 404);
});

test('viewer page, raw content and view counter', async () => {
  const { data: a } = await admin.post('/api/artifacts', { title: 'T <b>', content: '<p>body</p>' });
  const viewer = await anon.get(`/a/${a.id}`);
  assert.equal(viewer.status, 200);
  assert.match(viewer.text, /<iframe src="\/raw\/\w+\?ft=fd1\.[^"]+" sandbox="allow-scripts/);
  assert.match(viewer.text, /<title>T &lt;b&gt; · Artifacts<\/title>/, 'title is escaped');

  const raw = await anon.get(`/raw/${a.id}`);
  assert.equal(raw.status, 200);
  assert.match(raw.text, /^<!doctype html>/, 'fragments get wrapped in a document');
  assert.match(raw.text, /<p>body<\/p>/);

  const after = await admin.get(`/api/artifacts/${a.id}`);
  assert.equal(after.data.views, 1);
});

test('full HTML documents are served unchanged', async () => {
  const doc = '<!DOCTYPE html><html><head><title>x</title></head><body>full</body></html>';
  const { data: a } = await admin.post('/api/artifacts', { content: doc });
  assert.equal((await anon.get(`/raw/${a.id}`)).text, doc);
});

test('markdown is rendered to HTML', async () => {
  const { data: a } = await admin.post('/api/artifacts', { title: 'MD', kind: 'markdown', content: '# Head\n\n**bold**' });
  const raw = await anon.get(`/raw/${a.id}`);
  assert.match(raw.text, /<h1>Head<\/h1>/);
  assert.match(raw.text, /<strong>bold<\/strong>/);
});

test('file upload, attachment, range requests and delete', async () => {
  const up = await admin.post('/api/files?name=my picture.png', PNG, { headers: { 'Content-Type': 'text/html' } });
  assert.equal(up.status, 201);
  assert.equal(up.data.name, 'my_picture.png', 'filename is sanitized');
  assert.equal(up.data.mime, 'image/png', 'MIME comes from the extension, not the client');
  assert.match(up.data.preview_path, /\?pt=/);

  const { data: a } = await admin.post('/api/artifacts', { content: `<img src="${up.data.path}">`, files: [up.data.id] });
  const files = await admin.get(`/api/files?artifact=${a.id}`);
  assert.deepEqual(files.data.map((f) => f.id), [up.data.id]);

  const file = await anon.get(up.data.path, { raw: true });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PNG);

  const range = await anon.get(up.data.path, { headers: { Range: 'bytes=0-3' }, raw: true });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-3/${PNG.length}`);
  assert.equal((await range.arrayBuffer()).byteLength, 4);

  assert.equal((await admin.del(`/api/files/${up.data.id}`)).status, 200);
  assert.equal((await anon.get(up.data.path)).status, 404);
});

test('deleting an artifact deletes its files', async () => {
  const up = await admin.post('/api/files?name=a.png', PNG);
  const { data: a } = await admin.post('/api/artifacts', { content: 'x', files: [up.data.id] });
  const del = await admin.del(`/api/artifacts/${a.id}`);
  assert.deepEqual(del.data, { ok: true, deletedFiles: 1 });
  assert.equal((await anon.get(`/a/${a.id}`)).status, 404);
  assert.equal((await anon.get(up.data.path)).status, 404);
});

test('upload limits', async () => {
  assert.equal((await admin.post('/api/files?name=empty.png', new Uint8Array())).status, 400);
  assert.equal((await admin.post('/api/files?name=a.png&artifact=missing', PNG)).status, 404);
});

test('static assets and admin shell', async () => {
  for (const p of ['/', '/new', '/tokens', '/edit/abc', '/static/app.js', '/static/app.css', '/static/viewer.js', '/static/vendor/marked.esm.js']) {
    assert.equal((await anon.get(p)).status, 200, p);
  }
  assert.equal((await anon.get('/static/nope.js')).status, 404);
  assert.equal((await anon.get('/unknown')).status, 404);
});
