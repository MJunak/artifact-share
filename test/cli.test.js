import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PNG, ADMIN_TOKEN } from './helpers.js';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'artifact');
const hasTools = ['curl', 'jq'].every((bin) => process.env.PATH.split(':').some((d) => fs.existsSync(path.join(d, bin))));

let srv, tmp;
const cli = (args, token = ADMIN_TOKEN, input) =>
  run('bash', [CLI, ...args], { env: { ...process.env, ARTIFACT_SHARE_URL: srv.base, ARTIFACT_SHARE_TOKEN: token }, input });

before(async () => {
  srv = await startServer();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-cli-'));
});
after(async () => {
  await srv.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('CLI: publish, list, update, cat, versions, delete', { skip: !hasTools && 'curl/jq missing' }, async () => {
  const file = path.join(tmp, 'Report.md');
  fs.writeFileSync(file, '# Report\n');
  const { stdout } = await cli(['publish', file, '--description', 'weekly']);
  const [url, id, version] = stdout.trim().split('\t');
  assert.equal(url, `${srv.base}/a/${id}`);
  assert.equal(version, 'v1');

  const meta = JSON.parse((await cli(['get', id])).stdout);
  assert.equal(meta.title, 'Report');
  assert.equal(meta.kind, 'markdown');
  assert.equal(meta.description, 'weekly');

  assert.match((await cli(['list'])).stdout, new RegExp(`^${id}\\tv1\\t0 views\\tpublic\\tReport`, 'm'));

  fs.writeFileSync(file, '# Report v2\n');
  assert.match((await cli(['update', id, file, '--title', 'Report 2'])).stdout, /\tv2\tpublic$/m);
  assert.equal((await cli(['cat', id])).stdout, '# Report v2\n');
  assert.match((await cli(['update', id, '--unpublish'])).stdout, /\tdraft$/m);
  assert.equal((await cli(['versions', id])).stdout.trim().split('\n').length, 2);

  assert.match((await cli(['delete', id])).stdout, /"ok":true/);
});

test('CLI: upload a file to an artifact', { skip: !hasTools && 'curl/jq missing' }, async () => {
  const html = path.join(tmp, 'page.html');
  fs.writeFileSync(html, '<p>x</p>');
  const id = (await cli(['publish', html])).stdout.split('\t')[1];
  const png = path.join(tmp, 'my image.png');
  fs.writeFileSync(png, PNG);
  const up = JSON.parse((await cli(['upload', png, '--artifact', id])).stdout);
  assert.equal(up.name, 'my_image.png');
  assert.equal(up.mime, 'image/png');
  assert.match((await cli(['files', id])).stdout, new RegExp(up.id));
});

test('CLI: token lifecycle and scopes', { skip: !hasTools && 'curl/jq missing' }, async () => {
  const created = JSON.parse((await cli(['token-create', 'bot', '--scope', 'publish', '--days', '7'])).stdout);
  assert.match(created.token, /^as_/);
  assert.equal((await cli(['whoami'], created.token)).stdout.trim(), '{"via":"bearer","scope":"publish"}');
  await assert.rejects(cli(['tokens'], created.token), /error 403/);
  assert.match((await cli(['tokens'])).stdout, /\tbot\tpublish\t/);
  await cli(['token-revoke', created.id]);
  await assert.rejects(cli(['whoami'], created.token), /error 401/);
});

test('CLI: token is not passed on the command line', { skip: !hasTools && 'curl/jq missing' }, async () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.doesNotMatch(src, /-H\s+"Authorization/);
  assert.match(src, /-H @-/);
});
