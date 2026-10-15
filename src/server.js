import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { marked } from 'marked';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const env = process.env;
const PORT = Number(env.PORT || 3000);
const DATA_DIR = path.resolve(env.DATA_DIR || './data');
const ADMIN_TOKEN = env.ADMIN_TOKEN || '';
const SITE_NAME = env.SITE_NAME || 'Artifacts';
const MAX_UPLOAD_BYTES = Number(env.MAX_UPLOAD_MB || 25) * 1024 * 1024;
const MAX_CONTENT_BYTES = Number(env.MAX_CONTENT_MB || 10) * 1024 * 1024;
const MAX_ARTIFACT_STORAGE_BYTES = Number(env.MAX_ARTIFACT_STORAGE_MB || 20) * 1024 * 1024;
const MAX_STORAGE_VALUE_BYTES = Number(env.MAX_STORAGE_VALUE_MB || 1) * 1024 * 1024;
const SESSION_DAYS = Number(env.SESSION_DAYS || 30);
// Canonical public URL (e.g. https://artifacts.example.com). Used for every absolute link and for
// the CSRF origin check, so nothing depends on client-controlled Host / X-Forwarded-* headers.
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
// Optional separate origin for the admin UI and API (e.g. a VPN-only hostname). When set, share links
// use PUBLIC_URL, while login, cookies and the CSRF check use ADMIN_URL, and the admin UI / API answer
// only on the ADMIN_URL host — so the public hostname can never expose them, even if the proxy is misconfigured.
const ADMIN_URL = (env.ADMIN_URL || '').replace(/\/$/, '');
// Optional separate origin for artifact content. MUST be on a different registrable domain than
// PUBLIC_URL (e.g. example-usercontent.com), otherwise artifacts are "same-site" with the admin UI.
const CONTENT_URL = (env.CONTENT_URL || '').replace(/\/$/, '');
// Only trust X-Forwarded-For / -Proto when a reverse proxy we control sits in front.
const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
const ORPHAN_FILE_HOURS = Number(env.ORPHAN_FILE_HOURS || 24);

const normalizeHost = (h) => String(h || '').toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
const CONTENT_HOST = CONTENT_URL ? normalizeHost(new URL(CONTENT_URL).host) : '';
const ADMIN_HOST = ADMIN_URL ? normalizeHost(new URL(ADMIN_URL).host) : '';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
if (ADMIN_TOKEN.length < 32) fail('ADMIN_TOKEN must be set to at least 32 random characters (openssl rand -base64 32).');
if (!(MAX_ARTIFACT_STORAGE_BYTES > 0)) fail('MAX_ARTIFACT_STORAGE_MB must be greater than zero.');
if (!(MAX_STORAGE_VALUE_BYTES > 0 && MAX_STORAGE_VALUE_BYTES <= MAX_ARTIFACT_STORAGE_BYTES)) {
  fail('MAX_STORAGE_VALUE_MB must be greater than zero and no larger than MAX_ARTIFACT_STORAGE_MB.');
}
if (PUBLIC_URL && !/^https?:\/\/[^/]+$/.test(PUBLIC_URL)) fail('PUBLIC_URL must look like https://host[:port] without a path.');
if (ADMIN_URL && !/^https?:\/\/[^/]+$/.test(ADMIN_URL)) fail('ADMIN_URL must look like https://host[:port] without a path.');
if (ADMIN_URL && !PUBLIC_URL) fail('ADMIN_URL requires PUBLIC_URL.');
if (CONTENT_URL && ADMIN_URL && siteOf(new URL(CONTENT_URL).hostname) === siteOf(new URL(ADMIN_URL).hostname)) {
  fail(`CONTENT_URL (${CONTENT_URL}) must be on a different registrable domain than ADMIN_URL (${ADMIN_URL}).`);
}
if (CONTENT_URL && PUBLIC_URL && siteOf(new URL(CONTENT_URL).hostname) === siteOf(new URL(PUBLIC_URL).hostname)) {
  fail(`CONTENT_URL (${CONTENT_URL}) must be on a different registrable domain than PUBLIC_URL (${PUBLIC_URL}). ` +
    'A sibling subdomain is same-site and lets artifacts toss cookies onto the admin app. Leave CONTENT_URL unset instead.');
}

// Rough registrable-domain heuristic (last two labels). Good enough to catch the common mistake;
// for multi-part public suffixes like co.uk it is stricter, never looser.
function siteOf(hostname) {
  return hostname.toLowerCase().split('.').slice(-2).join('.');
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new DatabaseSync(path.join(DATA_DIR, 'artifacts.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS artifacts (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL CHECK (kind IN ('html', 'markdown')),
    content     TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    published   INTEGER NOT NULL DEFAULT 1,
    views       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );
  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    scope        TEXT NOT NULL CHECK (scope IN ('publish', 'admin')),
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER,
    last_used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash     TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifact_storage (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    scope       TEXT NOT NULL CHECK (scope IN ('personal', 'shared')),
    owner_id    TEXT NOT NULL,
    path        TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, scope, owner_id, path)
  );
  CREATE INDEX IF NOT EXISTS artifact_storage_prefix ON artifact_storage (artifact_id, scope, owner_id, path);
`);

const q = {
  listArtifacts: db.prepare(`SELECT id, title, description, kind, version, published, views, created_at, updated_at,
                              length(content) AS size FROM artifacts ORDER BY updated_at DESC`),
  getArtifact: db.prepare('SELECT * FROM artifacts WHERE id = ?'),
  insertArtifact: db.prepare(`INSERT INTO artifacts (id, title, description, kind, content, published, created_at, updated_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  updateArtifact: db.prepare(`UPDATE artifacts SET title = ?, description = ?, kind = ?, content = ?, published = ?,
                              version = ?, updated_at = ? WHERE id = ?`),
  deleteArtifact: db.prepare('DELETE FROM artifacts WHERE id = ?'),
  countView: db.prepare('UPDATE artifacts SET views = views + 1 WHERE id = ?'),
  insertVersion: db.prepare('INSERT INTO versions (artifact_id, version, title, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  listVersions: db.prepare('SELECT version, title, kind, length(content) AS size, created_at FROM versions WHERE artifact_id = ? ORDER BY version DESC'),
  getVersion: db.prepare('SELECT * FROM versions WHERE artifact_id = ? AND version = ?'),
  listFiles: db.prepare('SELECT * FROM files ORDER BY created_at DESC'),
  listFilesFor: db.prepare('SELECT * FROM files WHERE artifact_id = ? ORDER BY created_at DESC'),
  getFile: db.prepare('SELECT * FROM files WHERE id = ?'),
  getFileWithArtifact: db.prepare(`SELECT f.*, a.published AS artifact_published FROM files f
                                   LEFT JOIN artifacts a ON a.id = f.artifact_id WHERE f.id = ?`),
  insertFile: db.prepare('INSERT INTO files (id, artifact_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  attachFile: db.prepare('UPDATE files SET artifact_id = ? WHERE id = ? AND artifact_id IS NULL'),
  orphanFiles: db.prepare('SELECT id FROM files WHERE artifact_id IS NULL AND created_at < ?'),
  insertSession: db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
  deleteAllSessions: db.prepare('DELETE FROM sessions'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  listTokens: db.prepare('SELECT id, name, prefix, scope, created_at, expires_at, last_used_at FROM api_tokens ORDER BY created_at DESC'),
  getTokenByHash: db.prepare('SELECT id, scope, expires_at FROM api_tokens WHERE token_hash = ?'),
  insertToken: db.prepare('INSERT INTO api_tokens (id, name, token_hash, prefix, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  touchToken: db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?'),
  deleteToken: db.prepare('DELETE FROM api_tokens WHERE id = ?'),
  getStorage: db.prepare(`SELECT value, updated_at FROM artifact_storage
                          WHERE artifact_id = ? AND scope = ? AND owner_id = ? AND path = ?`),
  listStorage: db.prepare(`SELECT path, value, updated_at FROM artifact_storage
                           WHERE artifact_id = ? AND scope = ? AND owner_id = ? AND path LIKE ? ESCAPE '\\'
                           ORDER BY path LIMIT ?`),
  storageBytes: db.prepare(`SELECT COALESCE(SUM(length(CAST(path AS BLOB)) + length(CAST(value AS BLOB))), 0) AS bytes
                            FROM artifact_storage WHERE artifact_id = ?`),
  storageEntryBytes: db.prepare(`SELECT length(CAST(path AS BLOB)) + length(CAST(value AS BLOB)) AS bytes
                                 FROM artifact_storage WHERE artifact_id = ? AND scope = ? AND owner_id = ? AND path = ?`),
  setStorage: db.prepare(`INSERT INTO artifact_storage (artifact_id, scope, owner_id, path, value, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?)
                          ON CONFLICT (artifact_id, scope, owner_id, path)
                          DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
  insertStorage: db.prepare(`INSERT OR IGNORE INTO artifact_storage (artifact_id, scope, owner_id, path, value, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?)`),
  deleteStorage: db.prepare('DELETE FROM artifact_storage WHERE artifact_id = ? AND scope = ? AND owner_id = ? AND path = ?'),
};

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Rejection sampling keeps every character equally likely (57 symbols ≈ 5.83 bits each).
function randomId(len = 14) {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < limit && out.length < len) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const FRAME_DB_KEY = sha256('frame-db:' + ADMIN_TOKEN);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown', '.css': 'text/css', '.js': 'text/javascript',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.html': 'text/html', '.htm': 'text/html', '.zip': 'application/zip',
};
const STATIC_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// The extension decides; a client-supplied Content-Type is never trusted for anything renderable.
function guessMime(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  return base.slice(0, 120) || 'file';
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length'] || 0) > limit) throw new HttpError(413, 'Body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = MAX_CONTENT_BYTES + 64 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
  const buf = await readBody(req, limit);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    // Traefik appends the real peer; the right-most entry is the one our proxy saw.
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

// Origin the browser sees. From config when set, otherwise derived from the request (local dev only).
function appOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = String(req.headers.host || 'localhost').replace(/[^\w.:\-\[\]]/g, '');
  return `${proto}://${host}`;
}

// Origin of the admin UI: where the session cookie lives and where cookie-authenticated writes must come from.
const adminOrigin = (req) => ADMIN_URL || appOrigin(req);
const isHttps = (req) => adminOrigin(req).startsWith('https://');
const isAdminHost = (req) => !ADMIN_HOST || normalizeHost(req.headers.host) === ADMIN_HOST;

const viewerCookieName = (req) => (appOrigin(req).startsWith('https://') ? '__Host-as_viewer' : 'as_viewer');

function viewerIdentity(req) {
  const existing = readCookie(req, viewerCookieName(req));
  if (existing && /^[A-Za-z0-9_-]{32,100}$/.test(existing)) return { id: existing, fresh: false };
  return { id: crypto.randomBytes(24).toString('base64url'), fresh: true };
}

function setViewerCookie(req, res, id) {
  const secure = appOrigin(req).startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${viewerCookieName(req)}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
}

function frameDbToken(artifactId, ownerId, expiresAt = Date.now() + 24 * 3600_000) {
  const payload = Buffer.from(JSON.stringify({ v: 1, a: artifactId, o: ownerId, e: expiresAt })).toString('base64url');
  const sig = crypto.createHmac('sha256', FRAME_DB_KEY).update(payload).digest('base64url');
  return `fd1.${payload}.${sig}`;
}

function verifyFrameDbToken(raw, artifactId) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'fd1') return null;
  const expected = crypto.createHmac('sha256', FRAME_DB_KEY).update(parts[1]).digest();
  let actual;
  try { actual = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (payload?.v !== 1 || payload.a !== artifactId || payload.e < Date.now() || !/^[A-Za-z0-9_-]{32,100}$/.test(payload.o || '')) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Auth: admin token via Bearer header (API/CLI) or server-side session (UI)
// ---------------------------------------------------------------------------

function tokenMatches(candidate) {
  // Comparing hashes makes the comparison constant-time and length-independent.
  return crypto.timingSafeEqual(sha256(candidate), sha256(ADMIN_TOKEN));
}

// __Host- cookies require Secure, Path=/ and no Domain, so sibling subdomains cannot shadow them.
const cookieName = (req) => (isHttps(req) ? '__Host-as_session' : 'as_session');

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0 || part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim()); // first occurrence wins (most specific path)
    } catch {
      return null;
    }
  }
  return null;
}

function sessionValid(req) {
  const sid = readCookie(req, cookieName(req));
  if (!sid || sid.length > 100) return false;
  const row = q.getSession.get(sha256(sid).toString('hex'));
  return !!row && row.expires_at > Date.now();
}

// Failed auth attempts are throttled per client and globally — this covers /api/login and Bearer guessing.
const failures = new Map();
let globalFailures = { count: 0, reset: Date.now() + 60_000 };
const PER_IP_LIMIT = 10;
// Global cap only guards against distributed guessing; high enough that one attacker cannot lock out everyone.
const GLOBAL_LIMIT = 300;

function assertNotThrottled(req) {
  const now = Date.now();
  if (now > globalFailures.reset) globalFailures = { count: 0, reset: now + 60_000 };
  const entry = failures.get(clientIp(req));
  if ((entry && now < entry.reset && entry.count >= PER_IP_LIMIT) || globalFailures.count >= GLOBAL_LIMIT) {
    throw new HttpError(429, 'Too many failed attempts, try again in a minute');
  }
}

function recordFailure(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const entry = failures.get(ip);
  if (!entry || now > entry.reset) failures.set(ip, { count: 1, reset: now + 60_000 });
  else entry.count++;
  globalFailures.count++;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of failures) if (now > e.reset) failures.delete(ip);
}, 60_000).unref();

// API tokens: "as_" + 40 base62-ish chars. Only their SHA-256 is stored.
const TOKEN_PREFIX = 'as_';

function lookupApiToken(raw) {
  if (!raw.startsWith(TOKEN_PREFIX) || raw.length > 100) return null;
  const row = q.getTokenByHash.get(sha256(raw).toString('hex'));
  if (!row || (row.expires_at && row.expires_at < Date.now())) return null;
  q.touchToken.run(Date.now(), row.id);
  return row;
}

// Returns { via: 'bearer' | 'session', scope: 'admin' | 'publish' } or null.
function authenticate(req) {
  const auth = req.headers.authorization;
  if (auth !== undefined) {
    // An Authorization header must be a valid Bearer token; we never fall back to the cookie,
    // so ambient browser credentials (Basic/NTLM) cannot smuggle a cookie past the CSRF check.
    assertNotThrottled(req);
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    let result = null;
    if (raw && tokenMatches(raw)) result = { via: 'bearer', scope: 'admin' };
    else if (raw) {
      const row = lookupApiToken(raw);
      if (row) result = { via: 'bearer', scope: row.scope };
    }
    if (!result) recordFailure(req);
    return result;
  }
  return sessionValid(req) ? { via: 'session', scope: 'admin' } : null;
}

function requireAuth(req) {
  const auth = authenticate(req);
  if (!auth) throw new HttpError(401, 'Unauthorized');
  if (auth.via === 'session' && req.method !== 'GET' && req.method !== 'HEAD') assertSameOrigin(req);
  return auth;
}

function requireAdmin(auth) {
  if (auth.scope !== 'admin') throw new HttpError(403, "This action needs an 'admin' scoped token");
}

// CSRF defence for cookie-authenticated writes.
function assertSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') throw new HttpError(403, 'Cross-origin request rejected');
  if (req.headers.origin !== adminOrigin(req)) throw new HttpError(403, 'Cross-origin request rejected');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
const MARKDOWN_CSS = fs.readFileSync(path.join(PUBLIC_DIR, 'markdown.css'), 'utf8');

function artifactStorageBootstrap(artifactId, token) {
  const endpoint = `/frame/db/${artifactId}/call`;
  return `<script>(()=>{'use strict';
const endpoint=${JSON.stringify(endpoint)},token=${JSON.stringify(token)};
async function call(scope,verb,args={}){const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,scope,verb,...args})});const result=await response.json().catch(()=>({error:'Invalid storage response'}));if(!response.ok)throw new Error(result.error||('Storage request failed: '+response.status));return result;}
function store(scope){return Object.freeze({get:async(path)=>(await call(scope,'get',{path})).data,set:async(path,data,options={})=>call(scope,'set',{path,data,replace:options.replace!==false}),delete:(path)=>call(scope,'delete',{path}),list:async(prefix='',limit=100)=>(await call(scope,'list',{path:prefix,limit})).items});}
Object.defineProperty(window,'artifactDB',{value:Object.freeze({call,personal:store('personal'),shared:store('shared')}),writable:false,configurable:false});
})();</script>`;
}

function renderArtifactDocument(artifact, storageToken = '') {
  const bootstrap = storageToken ? artifactStorageBootstrap(artifact.id, storageToken) : '';
  if (artifact.kind === 'markdown') {
    return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${bootstrap}
<title>${escapeHtml(artifact.title)}</title><style>${MARKDOWN_CSS}</style></head>
<body><main>${marked.parse(artifact.content)}</main></body></html>`;
  }
  if (/^\s*(<!doctype|<html)/i.test(artifact.content)) {
    if (!bootstrap) return artifact.content;
    if (/<head(?:\s[^>]*)?>/i.test(artifact.content)) return artifact.content.replace(/<head(?:\s[^>]*)?>/i, (m) => m + bootstrap);
    if (/<html(?:\s[^>]*)?>/i.test(artifact.content)) return artifact.content.replace(/<html(?:\s[^>]*)?>/i, (m) => m + bootstrap);
    return artifact.content.replace(/^\s*(<!doctype[^>]*>)/i, (m) => m + bootstrap);
  }
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${bootstrap}
<title>${escapeHtml(artifact.title)}</title></head><body>
${artifact.content}
</body></html>`;
}

function renderViewer(req, artifact, storageToken) {
  const contentSrc = `${CONTENT_URL}/raw/${artifact.id}?ft=${encodeURIComponent(storageToken)}`;
  const sandbox = CONTENT_URL ? `${SANDBOX} allow-same-origin` : SANDBOX;
  const pageUrl = `${appOrigin(req)}/a/${artifact.id}`;
  const title = escapeHtml(artifact.title);
  const desc = escapeHtml(artifact.description || `Geteilt über ${SITE_NAME}`);
  const updated = new Date(artifact.updated_at).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${escapeHtml(SITE_NAME)}</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta property="og:type" content="website">
<meta name="robots" content="noindex">
<link rel="icon" href="/static/icon.svg">
<link rel="stylesheet" href="/static/viewer.css">
</head><body>
<header class="bar">
  <a class="brand" href="/a/${artifact.id}" title="${escapeHtml(SITE_NAME)}"><img src="/static/icon.svg" alt=""></a>
  <div class="meta"><h1>${title}</h1><span>v${artifact.version} · ${updated}</span></div>
  <div class="actions">
    <button type="button" id="copy" title="Link kopieren">Link kopieren</button>
    <a href="${escapeHtml(contentSrc)}" target="_blank" rel="noopener" title="In neuem Tab öffnen">Vollbild</a>
  </div>
</header>
<iframe src="${escapeHtml(contentSrc)}" sandbox="${sandbox}" allow="clipboard-write; fullscreen" allowfullscreen title="${title}"></iframe>
<script src="/static/viewer.js" data-url="${escapeHtml(pageUrl)}"></script>
</body></html>`;
}

function notFoundPage(message = 'Dieses Artifact existiert nicht oder wurde zurückgezogen.') {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nicht gefunden · ${escapeHtml(SITE_NAME)}</title><link rel="stylesheet" href="/static/viewer.css"></head>
<body class="empty"><div><h1>404</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

function baseHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (isHttps(req) || appOrigin(req).startsWith('https://')) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

// Admin UI and API: never framable. The editor preview is a srcdoc iframe, which inherits this
// policy — that is why there is no script-src here (app.js never uses innerHTML).
const ADMIN_HEADERS = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" };
// The viewer page may be embedded anywhere (wikis, Confluence, …).
const VIEWER_HEADERS = { 'Content-Security-Policy': "base-uri 'none'; object-src 'none'" };
// Raw content may only be framed by our own viewer.
const rawFrameAncestors = () => `frame-ancestors 'self'${PUBLIC_URL ? ` ${PUBLIC_URL}` : ''}${ADMIN_URL ? ` ${ADMIN_URL}` : ''}`;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function artifactPayload(body, existing) {
  const title = String(body.title ?? existing?.title ?? '').trim() || 'Ohne Titel';
  const description = String(body.description ?? existing?.description ?? '').trim().slice(0, 500);
  const kind = body.kind ?? existing?.kind ?? 'html';
  if (!['html', 'markdown'].includes(kind)) throw new HttpError(400, "kind must be 'html' or 'markdown'");
  const content = body.content ?? existing?.content;
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'content is required');
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new HttpError(413, 'content too large');
  const published = body.published === undefined ? (existing ? existing.published : 1) : (body.published ? 1 : 0);
  return { title: title.slice(0, 200), description, kind, content, published };
}

function publicArtifact(req, a) {
  const { content, ...rest } = a;
  return { ...rest, published: !!a.published, url: `${appOrigin(req)}/a/${a.id}` };
}

// Lets the sandboxed editor preview (no cookie) load files of unpublished artifacts.
const PREVIEW_KEY = sha256('preview:' + ADMIN_TOKEN);
const previewToken = (fileId) => crypto.createHmac('sha256', PREVIEW_KEY).update(fileId).digest('base64url').slice(0, 32);

function publicFile(req, f) {
  const p = `/f/${f.id}/${encodeURIComponent(f.name)}`;
  return {
    id: f.id, artifact_id: f.artifact_id, name: f.name, mime: f.mime, size: f.size, created_at: f.created_at,
    url: `${appOrigin(req)}${p}`, path: p, preview_path: `${p}?pt=${previewToken(f.id)}`,
  };
}

async function handleUpload(req, res, url) {
  const name = sanitizeFilename(url.searchParams.get('name'));
  const artifactId = url.searchParams.get('artifact') || null;
  if (artifactId && !q.getArtifact.get(artifactId)) throw new HttpError(404, 'artifact not found');
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, `File larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);

  const id = randomId(20);
  const target = path.join(FILES_DIR, id);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) cb(new HttpError(413, `File larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(target, { flags: 'wx' }));
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  }
  if (size === 0) {
    fs.rmSync(target, { force: true });
    throw new HttpError(400, 'Empty upload');
  }
  q.insertFile.run(id, artifactId, name, guessMime(name), size, Date.now());
  json(res, 201, publicFile(req, q.getFile.get(id)));
}

function serveFile(req, res, id, authed) {
  const file = q.getFileWithArtifact.get(id);
  const diskPath = path.join(FILES_DIR, id);
  // Files are public only while their artifact is published; drafts and editor uploads need a session.
  const visible = file && (file.artifact_published === 1 || authed);
  if (!visible || !fs.existsSync(diskPath)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain', ...baseHeaders(req) });

  const headers = {
    ...baseHeaders(req),
    'Content-Type': file.mime,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    // Short shared cache so unpublishing takes effect quickly; drafts are never cached by proxies.
    'Cache-Control': file.artifact_published === 1 ? 'public, max-age=300' : 'private, no-store',
    'Accept-Ranges': 'bytes',
    // Uploaded files never execute on our origin (matters for SVG and HTML).
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'; sandbox",
  };
  if (!/^(image\/(?!svg)|video\/|audio\/|font\/|application\/pdf)/.test(file.mime)) {
    headers['Content-Disposition'] = `attachment; filename="${file.name}"`;
  }
  // Text-like files used as artifact assets (css/js/json/svg) are allowed inline: CSP sandbox + nosniff keep them inert.
  if (/^(text\/css|text\/javascript|application\/json|image\/svg\+xml|text\/csv|text\/plain|text\/markdown)$/.test(file.mime)) {
    delete headers['Content-Disposition'];
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : file.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : file.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, file.size - 1);
    if (start > end) return send(res, 416, '', { 'Content-Range': `bytes */${file.size}` });
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(diskPath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': file.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(diskPath).pipe(res);
}

// Same marked build the server uses, so the editor preview matches the published page.
const MARKED_ESM = path.join(path.dirname(fileURLToPath(import.meta.resolve('marked'))), 'marked.esm.js');
const STATIC_FILES = new Set(['app.js', 'app.css', 'viewer.css', 'viewer.js', 'markdown.css', 'icon.svg']);

function serveStatic(req, res, rel) {
  const filePath = rel === 'vendor/marked.esm.js' ? MARKED_ESM : STATIC_FILES.has(rel) ? path.join(PUBLIC_DIR, rel) : null;
  if (!filePath) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain', ...baseHeaders(req) });
  send(res, 200, fs.readFileSync(filePath), {
    ...baseHeaders(req),
    ...ADMIN_HEADERS,
    'Content-Type': STATIC_MIME[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
}

function serveRaw(req, res, id, sandboxed, token = '') {
  const a = q.getArtifact.get(id);
  if (!a || !a.published) return send(res, 404, notFoundPage(), { 'Content-Type': 'text/html; charset=utf-8', ...baseHeaders(req) });
  const storage = verifyFrameDbToken(token, a.id) ? token : '';
  const csp = [rawFrameAncestors()];
  // On the main host the artifact always runs in an opaque origin, even when opened directly,
  // so its scripts can never reach the admin session.
  if (sandboxed) csp.push(`sandbox ${SANDBOX}`);
  send(res, 200, renderArtifactDocument(a, storage), {
    ...baseHeaders(req),
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'unsafe-none',
    'Content-Security-Policy': csp.join('; '),
  });
}

function storagePath(value, allowEmpty = false) {
  if (typeof value !== 'string') throw new HttpError(400, 'path must be a string');
  if ((!allowEmpty && !value) || value.includes('\0') || Buffer.byteLength(value) > 512) {
    throw new HttpError(400, `path must be ${allowEmpty ? 'at most' : 'between 1 and'} 512 bytes and contain no NUL byte`);
  }
  return value;
}

function storageContext(body, artifactId) {
  const token = verifyFrameDbToken(body.token, artifactId);
  if (!token) throw new HttpError(401, 'Invalid or expired artifact storage token');
  const artifact = q.getArtifact.get(artifactId);
  if (!artifact || !artifact.published) throw new HttpError(404, 'artifact not found');
  const scope = body.scope ?? 'personal';
  if (!['personal', 'shared'].includes(scope)) throw new HttpError(400, "scope must be 'personal' or 'shared'");
  return { scope, ownerId: scope === 'personal' ? token.o : '' };
}

async function handleFrameDbCall(req, res, artifactId) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

  const body = await readJson(req, MAX_STORAGE_VALUE_BYTES + 64 * 1024);
  const { scope, ownerId } = storageContext(body, artifactId);
  const verb = body.verb;

  if (verb === 'get') {
    const key = storagePath(body.path);
    const row = q.getStorage.get(artifactId, scope, ownerId, key);
    if (!row) return json(res, 200, { data: null, found: false });
    return json(res, 200, { data: JSON.parse(row.value), found: true, updated_at: row.updated_at });
  }

  if (verb === 'list') {
    const prefix = storagePath(body.path ?? '', true);
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(body.limit)) || 100));
    const like = prefix.replace(/[\\%_]/g, '\\$&') + '%';
    const rows = q.listStorage.all(artifactId, scope, ownerId, like, limit);
    return json(res, 200, { items: rows.map((row) => ({ path: row.path, data: JSON.parse(row.value), updated_at: row.updated_at })) });
  }

  if (verb === 'delete') {
    const key = storagePath(body.path);
    const deleted = q.deleteStorage.run(artifactId, scope, ownerId, key).changes > 0;
    return json(res, 200, { ok: true, deleted });
  }

  if (verb === 'set') {
    const key = storagePath(body.path);
    if (!Object.hasOwn(body, 'data')) throw new HttpError(400, 'data is required');
    const value = JSON.stringify(body.data);
    const valueBytes = Buffer.byteLength(value);
    if (valueBytes > MAX_STORAGE_VALUE_BYTES) throw new HttpError(413, 'Stored value is too large');
    const replace = body.replace !== false;
    const now = Date.now();
    let inserted = false;
    transaction(() => {
      const oldBytes = q.storageEntryBytes.get(artifactId, scope, ownerId, key)?.bytes || 0;
      const totalBytes = q.storageBytes.get(artifactId).bytes;
      if (totalBytes - oldBytes + Buffer.byteLength(key) + valueBytes > MAX_ARTIFACT_STORAGE_BYTES) {
        throw new HttpError(413, 'Artifact storage limit exceeded');
      }
      const result = replace
        ? q.setStorage.run(artifactId, scope, ownerId, key, value, now)
        : q.insertStorage.run(artifactId, scope, ownerId, key, value, now);
      inserted = result.changes > 0;
      if (!replace && !inserted) throw new HttpError(409, 'path already exists');
    });
    return json(res, 200, { ok: true, path: key, updated_at: now });
  }

  throw new HttpError(400, "verb must be 'get', 'set', 'delete' or 'list'");
}

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const m = req.method;
  const isRead = m === 'GET' || m === 'HEAD';
  let mm;

  // Requests on the separate content host only get artifact content and files.
  if (CONTENT_HOST && normalizeHost(req.headers.host) === CONTENT_HOST) {
    if ((mm = p.match(/^\/frame\/db\/(\w+)\/call$/))) return handleFrameDbCall(req, res, mm[1]);
    if (isRead && (mm = p.match(/^\/raw\/(\w+)$/))) return serveRaw(req, res, mm[1], false, url.searchParams.get('ft') || '');
    if (isRead && (mm = p.match(/^\/f\/(\w+)(?:\/[^/]*)?$/))) return serveFile(req, res, mm[1], false);
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }

  if (p === '/healthz') return json(res, 200, { ok: true });

  // With ADMIN_URL, every other host gets only the public routes below (viewer, raw, files, frame DB, static).
  const adminRoute = p.startsWith('/api/') || p === '/' || p === '/new' || p === '/tokens' || /^\/edit\/\w+$/.test(p);
  if (adminRoute && !isAdminHost(req)) {
    return send(res, 404, notFoundPage('Seite nicht gefunden.'), { 'Content-Type': 'text/html; charset=utf-8', ...baseHeaders(req) });
  }

  // --- Admin UI --------------------------------------------------------------
  if (m === 'GET' && (p === '/' || p === '/new' || p === '/tokens' || /^\/edit\/\w+$/.test(p))) {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8').replaceAll('{{SITE_NAME}}', escapeHtml(SITE_NAME));
    return send(res, 200, body, {
      ...baseHeaders(req), ...ADMIN_HEADERS,
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Referrer-Policy': 'same-origin',
    });
  }
  if (m === 'GET' && p.startsWith('/static/')) return serveStatic(req, res, p.slice('/static/'.length));

  // --- Public viewing --------------------------------------------------------
  if (m === 'GET' && (mm = p.match(/^\/a\/(\w+)$/))) {
    const a = q.getArtifact.get(mm[1]);
    if (!a || !a.published) return send(res, 404, notFoundPage(), { 'Content-Type': 'text/html; charset=utf-8', ...baseHeaders(req) });
    const viewer = viewerIdentity(req);
    if (viewer.fresh) setViewerCookie(req, res, viewer.id);
    const storageToken = frameDbToken(a.id, viewer.id);
    q.countView.run(a.id);
    return send(res, 200, renderViewer(req, a, storageToken), {
      ...baseHeaders(req), ...VIEWER_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
    });
  }
  if (isRead && (mm = p.match(/^\/raw\/(\w+)$/))) {
    if (CONTENT_URL) {
      res.writeHead(302, { Location: `${CONTENT_URL}/raw/${mm[1]}` });
      return res.end();
    }
    return serveRaw(req, res, mm[1], true, url.searchParams.get('ft') || '');
  }
  if ((mm = p.match(/^\/frame\/db\/(\w+)\/call$/))) return handleFrameDbCall(req, res, mm[1]);
  if (isRead && (mm = p.match(/^\/f\/(\w+)(?:\/[^/]*)?$/))) {
    const pt = url.searchParams.get('pt') || '';
    const previewOk = pt.length === 32 && crypto.timingSafeEqual(Buffer.from(pt), Buffer.from(previewToken(mm[1])));
    return serveFile(req, res, mm[1], previewOk || (!req.headers.authorization && sessionValid(req)));
  }

  // --- API -------------------------------------------------------------------
  if (p.startsWith('/api/')) res.setHeader('X-Frame-Options', 'DENY');

  if (p === '/api/login' && m === 'POST') {
    assertSameOrigin(req);
    assertNotThrottled(req);
    const body = await readJson(req, 4096);
    if (typeof body.token !== 'string' || !tokenMatches(body.token)) {
      recordFailure(req);
      throw new HttpError(401, 'Falsches Token');
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    q.pruneSessions.run(now);
    q.insertSession.run(sha256(sid).toString('hex'), now, now + SESSION_DAYS * 86400_000);
    const secure = isHttps(req) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${cookieName(req)}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/logout' && m === 'POST') {
    assertSameOrigin(req);
    const sid = readCookie(req, cookieName(req));
    if (sid) q.deleteSession.run(sha256(sid).toString('hex'));
    const secure = isHttps(req) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${cookieName(req)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'GET') {
    return json(res, 200, { authed: !req.headers.authorization && sessionValid(req), siteName: SITE_NAME, maxUploadMb: MAX_UPLOAD_BYTES / 1024 / 1024 });
  }

  if (p.startsWith('/api/')) {
    const auth = requireAuth(req);

    if (p === '/api/whoami' && m === 'GET') return json(res, 200, { via: auth.via, scope: auth.scope });
    if (p === '/api/sessions' && m === 'DELETE') {
      requireAdmin(auth);
      q.deleteAllSessions.run();
      return json(res, 200, { ok: true });
    }

    // --- API tokens (admin scope only, so a leaked publish token cannot mint more) ---
    if (p === '/api/tokens' && m === 'GET') {
      requireAdmin(auth);
      return json(res, 200, q.listTokens.all());
    }
    if (p === '/api/tokens' && m === 'POST') {
      requireAdmin(auth);
      const body = await readJson(req, 4096);
      const name = String(body.name || '').trim().slice(0, 100);
      if (!name) throw new HttpError(400, 'name is required');
      const scope = body.scope ?? 'publish';
      if (!['publish', 'admin'].includes(scope)) throw new HttpError(400, "scope must be 'publish' or 'admin'");
      const days = body.expires_in_days == null ? null : Number(body.expires_in_days);
      if (days !== null && !(days > 0 && days <= 3650)) throw new HttpError(400, 'expires_in_days must be between 1 and 3650');
      const raw = TOKEN_PREFIX + randomId(40);
      const id = randomId(10);
      const now = Date.now();
      q.insertToken.run(id, name, sha256(raw).toString('hex'), raw.slice(0, 7), scope, now, days ? now + days * 86400_000 : null);
      return json(res, 201, { id, name, scope, prefix: raw.slice(0, 7), created_at: now, expires_at: days ? now + days * 86400_000 : null, token: raw });
    }
    if ((mm = p.match(/^\/api\/tokens\/(\w+)$/)) && m === 'DELETE') {
      requireAdmin(auth);
      if (!q.deleteToken.run(mm[1]).changes) throw new HttpError(404, 'token not found');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/artifacts' && m === 'GET') return json(res, 200, q.listArtifacts.all().map((a) => publicArtifact(req, a)));
    if (p === '/api/artifacts' && m === 'POST') {
      const body = await readJson(req);
      const data = artifactPayload(body);
      const id = randomId();
      const now = Date.now();
      transaction(() => {
        q.insertArtifact.run(id, data.title, data.description, data.kind, data.content, data.published, now, now);
        q.insertVersion.run(id, 1, data.title, data.kind, data.content, now);
        // Files uploaded in the editor before the first save get attached to the new artifact.
        for (const fileId of Array.isArray(body.files) ? body.files : []) q.attachFile.run(id, String(fileId));
      });
      return json(res, 201, { ...publicArtifact(req, q.getArtifact.get(id)), content: data.content });
    }
    if ((mm = p.match(/^\/api\/artifacts\/(\w+)$/))) {
      const a = q.getArtifact.get(mm[1]);
      if (!a) throw new HttpError(404, 'artifact not found');
      if (m === 'GET') return json(res, 200, { ...publicArtifact(req, a), content: a.content });
      if (m === 'PUT' || m === 'PATCH') {
        const data = artifactPayload(await readJson(req), a);
        const contentChanged = data.content !== a.content || data.kind !== a.kind || data.title !== a.title;
        const version = contentChanged ? a.version + 1 : a.version;
        const now = Date.now();
        transaction(() => {
          q.updateArtifact.run(data.title, data.description, data.kind, data.content, data.published, version, now, a.id);
          if (contentChanged) q.insertVersion.run(a.id, version, data.title, data.kind, data.content, now);
        });
        const updated = q.getArtifact.get(a.id);
        return json(res, 200, { ...publicArtifact(req, updated), content: updated.content });
      }
      if (m === 'DELETE') {
        const files = q.listFilesFor.all(a.id);
        transaction(() => {
          for (const f of files) q.deleteFile.run(f.id);
          q.deleteArtifact.run(a.id);
        });
        for (const f of files) fs.rmSync(path.join(FILES_DIR, f.id), { force: true });
        return json(res, 200, { ok: true, deletedFiles: files.length });
      }
    }
    if ((mm = p.match(/^\/api\/artifacts\/(\w+)\/versions$/)) && m === 'GET') return json(res, 200, q.listVersions.all(mm[1]));
    if ((mm = p.match(/^\/api\/artifacts\/(\w+)\/versions\/(\d+)$/)) && m === 'GET') {
      const v = q.getVersion.get(mm[1], Number(mm[2]));
      if (!v) throw new HttpError(404, 'version not found');
      return json(res, 200, v);
    }

    if (p === '/api/files' && m === 'GET') {
      const artifact = url.searchParams.get('artifact');
      return json(res, 200, (artifact ? q.listFilesFor.all(artifact) : q.listFiles.all()).map((f) => publicFile(req, f)));
    }
    if (p === '/api/files' && m === 'POST') return handleUpload(req, res, url);
    if ((mm = p.match(/^\/api\/files\/(\w+)$/)) && m === 'DELETE') {
      if (!q.getFile.get(mm[1])) throw new HttpError(404, 'file not found');
      q.deleteFile.run(mm[1]);
      fs.rmSync(path.join(FILES_DIR, mm[1]), { force: true });
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Unknown API route');
  }

  return send(res, 404, notFoundPage('Seite nicht gefunden.'), { 'Content-Type': 'text/html; charset=utf-8', ...baseHeaders(req) });
}

// Uploads that never got attached to an artifact (editor closed before saving) are removed.
function sweepOrphans() {
  const cutoff = Date.now() - ORPHAN_FILE_HOURS * 3600_000;
  for (const { id } of q.orphanFiles.all(cutoff)) {
    q.deleteFile.run(id);
    fs.rmSync(path.join(FILES_DIR, id), { force: true });
  }
  q.pruneSessions.run(Date.now());
}
sweepOrphans();
setInterval(sweepOrphans, 3600_000).unref();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Internal error' : err.message });
    else res.destroy();
  }
});

server.requestTimeout = 10 * 60_000;
server.headersTimeout = 20_000;
server.listen(PORT, () => {
  console.log(`${SITE_NAME} listening on :${PORT} (data: ${DATA_DIR}, public: ${PUBLIC_URL || 'from request'}` +
    `${ADMIN_URL ? `, admin: ${ADMIN_URL}` : ''}` +
    `${CONTENT_URL ? `, content: ${CONTENT_URL}` : ''}, trust proxy: ${TRUST_PROXY})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
