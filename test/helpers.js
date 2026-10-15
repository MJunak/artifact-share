import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdefghijkl';

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Starts a real server process on a random port with a throwaway data directory. */
export async function startServer(env = {}) {
  const port = await freePort();
  if (typeof env === 'function') env = env(port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-share-test-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ADMIN_TOKEN, PORT: String(port), DATA_DIR: dataDir, NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    base,
    dataDir,
    output: () => output,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Runs the server with the given env and resolves with its exit code and output (for startup guards). */
export async function runServerExpectingExit(env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-share-test-')), NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise((r) => child.once('exit', r));
  clearTimeout(timer);
  return { code, output };
}

/** Small HTTP client bound to one server. */
export function client(base, defaults = {}) {
  const request = async (method, p, { body, headers = {}, raw = false } = {}) => {
    const init = { method, headers: { ...defaults.headers, ...headers }, redirect: 'manual' };
    if (body !== undefined) {
      if (body instanceof Uint8Array || typeof body === 'string') init.body = body;
      else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] ??= 'application/json';
      }
    }
    const res = await fetch(base + p, init);
    if (raw) return res;
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, data, text };
  };
  return {
    get: (p, o) => request('GET', p, o),
    head: (p, o) => request('HEAD', p, o),
    post: (p, body, o = {}) => request('POST', p, { ...o, body }),
    put: (p, body, o = {}) => request('PUT', p, { ...o, body }),
    del: (p, o) => request('DELETE', p, o),
  };
}

export const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Logs in through the browser flow and returns a client that sends the session cookie + same-origin headers. */
export async function loginSession(base) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, client: client(base, { headers: { Cookie: cookie, Origin: base, 'Sec-Fetch-Site': 'same-origin' } }) };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
