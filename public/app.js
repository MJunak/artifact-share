const app = document.getElementById('app');
const state = { me: null, artifacts: [], pendingFiles: [] };

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
    body: opts.body && !(opts.body instanceof Blob) ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    state.me = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link kopiert');
  } catch {
    prompt('Kopieren:', text);
  }
}

function fromTemplate(id) {
  return document.getElementById(id).content.cloneNode(true);
}

function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  if (s < 86400 * 7) return `vor ${Math.round(s / 86400)} Tagen`;
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

function navigate(path) {
  history.pushState(null, '', path);
  render();
}

window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (a.pathname === location.pathname || !confirmLeave()) return;
    navigate(a.pathname);
  }
});

let dirty = false;
function confirmLeave() {
  return !dirty || confirm('Ungespeicherte Änderungen verwerfen?');
}
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function render() {
  dirty = false;
  if (!state.me) state.me = await api('/api/me');
  if (!state.me.authed) return renderLogin();
  const m = location.pathname.match(/^\/edit\/(\w+)$/);
  if (location.pathname === '/new') return renderEditor(null);
  if (location.pathname === '/tokens') return renderTokens();
  if (m) return renderEditor(m[1]);
  return renderList();
}

function renderLogin() {
  app.replaceChildren(fromTemplate('tpl-login'));
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.error');
    try {
      await api('/api/login', { method: 'POST', body: { token: form.token.value } });
      state.me = null;
      render();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

async function renderList() {
  app.replaceChildren(fromTemplate('tpl-list'));
  document.getElementById('logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' });
    state.me = null;
    render();
  };
  state.artifacts = await api('/api/artifacts');
  const search = document.getElementById('search');
  const draw = () => {
    const needle = search.value.trim().toLowerCase();
    const items = state.artifacts.filter((a) => !needle || `${a.title} ${a.description}`.toLowerCase().includes(needle));
    document.getElementById('empty').hidden = state.artifacts.length > 0;
    document.getElementById('items').replaceChildren(...items.map(artifactCard));
  };
  search.oninput = draw;
  draw();

  // Drop a .html/.md file anywhere on the list to publish it immediately.
  const main = document.querySelector('main.list');
  main.addEventListener('dragover', (e) => {
    e.preventDefault();
    main.classList.add('dragging');
  });
  main.addEventListener('dragleave', () => main.classList.remove('dragging'));
  main.addEventListener('drop', async (e) => {
    e.preventDefault();
    main.classList.remove('dragging');
    for (const file of e.dataTransfer.files) {
      if (!/\.(html?|md|markdown)$/i.test(file.name)) {
        toast(`${file.name}: nur .html oder .md`, true);
        continue;
      }
      const created = await api('/api/artifacts', {
        method: 'POST',
        body: {
          title: file.name.replace(/\.[^.]+$/, ''),
          kind: /\.html?$/i.test(file.name) ? 'html' : 'markdown',
          content: await file.text(),
        },
      });
      toast(`„${created.title}" veröffentlicht`);
    }
    renderList();
  });
}

async function renderTokens() {
  app.replaceChildren(fromTemplate('tpl-tokens'));
  document.title = `API-Tokens · ${state.me.siteName}`;
  const form = document.getElementById('token-form');
  const draw = async () => {
    const tokens = await api('/api/tokens');
    document.getElementById('tokens-empty').hidden = tokens.length > 0;
    document.getElementById('tokens').replaceChildren(...tokens.map((t) => h('article', { class: 'item' },
      h('div', { class: 'item-main' },
        h('div', { class: 'item-title' }, t.name, h('span', { class: 'badge' }, t.scope)),
        h('div', { class: 'item-meta muted small' },
          `${t.prefix}… · erstellt ${relTime(t.created_at)} · ` +
          `${t.last_used_at ? `zuletzt genutzt ${relTime(t.last_used_at)}` : 'nie genutzt'}` +
          `${t.expires_at ? ` · läuft ab ${new Date(t.expires_at).toLocaleDateString('de-DE')}` : ''}`),
      ),
      h('div', { class: 'item-actions' },
        h('button', {
          class: 'ghost small danger',
          onclick: async () => {
            if (!confirm(`Token „${t.name}" widerrufen? Clients damit verlieren sofort den Zugriff.`)) return;
            await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
            toast('Widerrufen');
            draw();
          },
        }, 'Widerrufen'),
      ),
    )));
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const created = await api('/api/tokens', {
        method: 'POST',
        body: { name: form.name.value, scope: form.scope.value, expires_in_days: form.expires.value ? Number(form.expires.value) : null },
      });
      document.getElementById('new-token').hidden = false;
      document.getElementById('new-token-value').textContent = created.token;
      document.getElementById('copy-token').onclick = () => copy(created.token);
      form.reset();
      draw();
    } catch (ex) {
      toast(ex.message, true);
    }
  });
  draw();
}

function artifactCard(a) {
  return h('article', { class: `item${a.published ? '' : ' draft'}` },
    h('a', { class: 'item-main', href: `/edit/${a.id}`, 'data-nav': true },
      h('div', { class: 'item-title' }, a.title, a.published ? null : h('span', { class: 'badge' }, 'privat')),
      a.description ? h('div', { class: 'item-desc muted' }, a.description) : null,
      h('div', { class: 'item-meta muted small' },
        `${a.kind === 'markdown' ? 'Markdown' : 'HTML'} · v${a.version} · ${a.views} Aufrufe · ${relTime(a.updated_at)}`),
    ),
    h('div', { class: 'item-actions' },
      h('a', { class: 'button ghost small', href: a.url, target: '_blank', rel: 'noopener' }, 'Öffnen ↗'),
      h('button', { class: 'ghost small', onclick: () => copy(a.url) }, 'Link'),
      h('button', {
        class: 'ghost small danger',
        onclick: async () => {
          if (!confirm(`„${a.title}" und alle zugehörigen Dateien endgültig löschen?`)) return;
          await api(`/api/artifacts/${a.id}`, { method: 'DELETE' });
          toast('Gelöscht');
          renderList();
        },
      }, 'Löschen'),
    ),
  );
}

async function renderEditor(id) {
  app.replaceChildren(fromTemplate('tpl-editor'));
  const $ = (sel) => document.getElementById(sel);
  const title = $('title'), description = $('description'), kind = $('kind'), content = $('content');
  const published = $('published'), preview = $('preview'), versions = $('versions');
  let artifact = null;
  state.pendingFiles = [];

  if (id) {
    try {
      artifact = await api(`/api/artifacts/${id}`);
    } catch (e) {
      toast(e.message, true);
      return navigate('/');
    }
    title.value = artifact.title;
    description.value = artifact.description;
    kind.value = artifact.kind;
    content.value = artifact.content;
    published.checked = artifact.published;
    document.title = `${artifact.title} · ${state.me.siteName}`;
  } else {
    document.title = `Neues Artifact · ${state.me.siteName}`;
    title.focus();
  }

  const showLinks = () => {
    const open = $('open-link');
    open.hidden = $('copy-link').hidden = !artifact;
    if (artifact) {
      open.href = artifact.url;
      $('copy-link').onclick = () => copy(artifact.url);
      $('status').textContent = `v${artifact.version} · gespeichert ${relTime(artifact.updated_at)}`;
    }
  };
  showLinks();

  // --- Preview ---------------------------------------------------------------
  const md = await loadMarkdownRenderer();
  let knownFiles = [];
  const updatePreview = () => {
    // The preview runs without cookies, so file links get their signed preview variant.
    let src = content.value;
    for (const f of knownFiles) src = src.replaceAll(f.path, f.preview_path);
    preview.srcdoc = kind.value === 'markdown'
      ? `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/markdown.css"><main>${md(src)}</main>`
      : src;
  };
  let previewTimer;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 350);
  };
  updatePreview();
  $('toggle-preview').onclick = (e) => {
    const editor = document.querySelector('main.editor');
    editor.classList.toggle('no-preview');
    e.target.textContent = editor.classList.contains('no-preview') ? 'Einblenden' : 'Ausblenden';
  };

  const markDirty = () => {
    dirty = true;
    $('status').textContent = 'Ungespeichert';
  };
  for (const el of [title, description, content]) el.addEventListener('input', markDirty);
  for (const el of [kind, published]) el.addEventListener('change', markDirty);
  content.addEventListener('input', schedulePreview);
  kind.addEventListener('change', updatePreview);

  // Tab inserts spaces instead of leaving the textarea.
  content.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      insertAtCursor(content, '  ');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  });
  document.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      save();
    }
  };

  // --- Versions --------------------------------------------------------------
  const loadVersions = async () => {
    if (!artifact) return;
    const list = await api(`/api/artifacts/${artifact.id}/versions`);
    versions.hidden = list.length < 2;
    versions.replaceChildren(
      h('option', { value: '' }, `Versionen (${list.length})`),
      ...list.map((v) => h('option', { value: v.version }, `v${v.version} · ${relTime(v.created_at)}`)),
    );
  };
  versions.onchange = async () => {
    if (!versions.value) return;
    if (!confirmLeave()) return void (versions.value = '');
    const v = await api(`/api/artifacts/${artifact.id}/versions/${versions.value}`);
    title.value = v.title;
    kind.value = v.kind;
    content.value = v.content;
    updatePreview();
    markDirty();
    toast(`v${v.version} geladen — Speichern stellt sie als neue Version wieder her`);
    versions.value = '';
  };
  loadVersions();

  // --- Files -----------------------------------------------------------------
  const filesEl = $('files');
  const drawFiles = async () => {
    const list = artifact ? await api(`/api/files?artifact=${artifact.id}`) : state.pendingFiles;
    knownFiles = list;
    schedulePreview();
    filesEl.replaceChildren(...list.map((f) => fileTile(f, content, drawFiles)));
    if (!list.length) filesEl.append(h('p', { class: 'muted small' }, 'Noch keine Dateien. Bilder einfach in den Editor ziehen oder einfügen.'));
  };
  drawFiles();

  const uploadFiles = async (files, insert) => {
    for (const file of files) {
      $('status').textContent = `Lade ${file.name} hoch…`;
      try {
        const qs = new URLSearchParams({ name: file.name });
        if (artifact) qs.set('artifact', artifact.id);
        const uploaded = await api(`/api/files?${qs}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
        if (!artifact) state.pendingFiles.unshift(uploaded);
        if (insert) {
          insertAtCursor(content, snippetFor(uploaded, kind.value));
          schedulePreview();
          markDirty();
        }
      } catch (e) {
        toast(`${file.name}: ${e.message}`, true);
      }
    }
    $('status').textContent = '';
    drawFiles();
  };

  $('upload').onchange = (e) => uploadFiles([...e.target.files], true);
  $('import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (content.value.trim() && !confirm('Aktuellen Inhalt ersetzen?')) return;
    content.value = await file.text();
    kind.value = /\.(md|markdown)$/i.test(file.name) ? 'markdown' : 'html';
    if (!title.value) title.value = file.name.replace(/\.[^.]+$/, '');
    updatePreview();
    markDirty();
  };
  content.addEventListener('dragover', (e) => e.preventDefault());
  content.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    uploadFiles([...e.dataTransfer.files], true);
  });
  content.addEventListener('paste', (e) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    e.preventDefault();
    uploadFiles(files.map((f, i) => (f.name === 'image.png' ? new File([f], `paste-${Date.now()}-${i}.png`, { type: f.type }) : f)), true);
  });

  // --- Save ------------------------------------------------------------------
  async function save() {
    const body = {
      title: title.value,
      description: description.value,
      kind: kind.value,
      content: content.value,
      published: published.checked,
    };
    if (!body.content.trim()) return toast('Inhalt ist leer', true);
    $('save').disabled = true;
    try {
      if (artifact) {
        artifact = await api(`/api/artifacts/${artifact.id}`, { method: 'PUT', body });
        toast(`Gespeichert (v${artifact.version})`);
      } else {
        artifact = await api('/api/artifacts', { method: 'POST', body: { ...body, files: state.pendingFiles.map((f) => f.id) } });
        history.replaceState(null, '', `/edit/${artifact.id}`);
        copy(artifact.url).catch(() => {});
        toast('Veröffentlicht — Link kopiert');
      }
      dirty = false;
      title.value = artifact.title;
      document.title = `${artifact.title} · ${state.me.siteName}`;
      showLinks();
      loadVersions();
      drawFiles();
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('save').disabled = false;
    }
  }
  $('save').onclick = save;
}

function fileTile(f, textarea, refresh) {
  const isImage = f.mime.startsWith('image/');
  const kind = document.getElementById('kind');
  return h('div', { class: 'file', title: `${f.name} · ${formatSize(f.size)}` },
    h('button', {
      class: 'file-thumb',
      onclick: () => {
        insertAtCursor(textarea, snippetFor(f, kind.value));
        textarea.dispatchEvent(new Event('input'));
      },
    }, isImage ? h('img', { src: f.path, alt: f.name, loading: 'lazy' }) : h('span', {}, f.name.split('.').pop().toUpperCase())),
    h('div', { class: 'file-name' }, f.name),
    h('div', { class: 'file-actions' },
      h('button', { class: 'ghost small', title: 'URL kopieren', onclick: () => copy(f.url) }, 'URL'),
      h('button', {
        class: 'ghost small danger',
        title: 'Löschen',
        onclick: async () => {
          if (!confirm(`${f.name} löschen? Verweise darauf brechen.`)) return;
          await api(`/api/files/${f.id}`, { method: 'DELETE' });
          state.pendingFiles = state.pendingFiles.filter((p) => p.id !== f.id);
          refresh();
        },
      }, '✕'),
    ),
  );
}

function snippetFor(f, kind) {
  const isImage = f.mime.startsWith('image/');
  const isVideo = f.mime.startsWith('video/');
  if (kind === 'markdown') return isImage ? `![${f.name}](${f.path})\n` : `[${f.name}](${f.path})\n`;
  if (isImage) return `<img src="${f.path}" alt="${f.name}">\n`;
  if (isVideo) return `<video src="${f.path}" controls></video>\n`;
  return `<a href="${f.path}">${f.name}</a>\n`;
}

function insertAtCursor(textarea, text) {
  textarea.focus();
  const { selectionStart: s, selectionEnd: e, value } = textarea;
  textarea.value = value.slice(0, s) + text + value.slice(e);
  textarea.selectionStart = textarea.selectionEnd = s + text.length;
}

// The server renders Markdown with `marked`; the editor preview uses the same library from the server's node_modules.
async function loadMarkdownRenderer() {
  const { marked } = await import('/static/vendor/marked.esm.js');
  return (src) => marked.parse(src);
}

render();
