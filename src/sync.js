// Keeps the same data on the phone and on the PC through a hidden file in the
// person's own Google Drive (the "appDataFolder", which only this app can see).
//
// Each device remembers the last version it agreed with the Drive ("base"). A sync
// is a three-way merge of base, this device and the Drive: whatever changed on only
// one side is kept, lists of things with an id (movements, accounts...) are merged
// item by item, and if the same value changed on both sides the newest one wins.
import { registerPlugin } from '@capacitor/core';
import { GOOGLE_WEB_CLIENT_ID } from './config.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'livro-de-contas.json';
const KEY_STATE = 'ldc-sync:state';   // { on, firstDone, lastSync, choice }
const KEY_BASE = 'ldc-sync:base';     // { path: data } as last agreed with the Drive
const KEY_TIMES = 'ldc-sync:times';   // { path: ms of last change on this device }

// ---------- merge ----------

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return v === undefined ? 'u' : JSON.stringify(v);
}
const same = (a, b) => stable(a) === stable(b);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const idList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && x.id != null);

export function merge3(b, l, r, localNewer) {
  if (same(l, r)) return l;
  if (same(b, l)) return r;
  if (same(b, r)) return l;
  if (isObj(l) && isObj(r)) {
    const out = {}, bb = isObj(b) ? b : {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const v = merge3(bb[k], l[k], r[k], localNewer);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if ((idList(l) || (Array.isArray(l) && !l.length)) && (idList(r) || (Array.isArray(r) && !r.length)) && (idList(l) || idList(r))) {
    const map = (a) => new Map((Array.isArray(a) ? a : []).filter((x) => isObj(x) && x.id != null).map((x) => [String(x.id), x]));
    const bm = map(b), lm = map(l), rm = map(r), out = [];
    for (const id of new Set([...lm.keys(), ...rm.keys()])) {
      const v = merge3(bm.get(id), lm.get(id), rm.get(id), localNewer);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  return localNewer ? l : r;
}

// ---------- Google sign-in ----------

let token = null, tokenUntil = 0;
const DriveAuth = registerPlugin('DriveAuth');

async function nativeToken(interactive) {
  const res = await DriveAuth.authorize({ interactive });
  if (!res || !res.accessToken) throw Object.assign(new Error('login'), { code: 'login' });
  return res.accessToken;
}

let gisLoading = null;
function loadGis() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (!gisLoading) gisLoading = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = ok; s.onerror = () => { gisLoading = null; fail(new Error('gis')); };
    document.head.appendChild(s);
  });
  return gisLoading;
}
async function webToken(interactive) {
  // In the browser a token lasts about an hour; getting a new one opens a small Google
  // window, which browsers only allow right after a click.
  if (!interactive) throw Object.assign(new Error('login'), { code: 'login' });
  await loadGis();
  return new Promise((ok, fail) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_WEB_CLIENT_ID,
      scope: SCOPE,
      callback: (r) => (r && r.access_token ? ok(r) : fail(Object.assign(new Error('login'), { code: 'login' }))),
      error_callback: () => fail(Object.assign(new Error('login'), { code: 'login' })),
    });
    client.requestAccessToken({ prompt: '' });
  }).then((r) => {
    try { sessionStorage.setItem('ldc-sync:token', JSON.stringify({ t: r.access_token, until: Date.now() + (r.expires_in - 120) * 1000 })); } catch (e) {}
    tokenUntil = Date.now() + (r.expires_in - 120) * 1000;
    return r.access_token;
  });
}

export function createSync({ native, store, docs, applyDoc }) {
  const listeners = new Set();
  let state = { on: false };
  let base = null, times = {};
  let status = 'off';     // off | idle | syncing | login | choose | error | unconfigured
  let lastError = '';
  let running = null, again = false, timer = null;

  const configured = native || !!GOOGLE_WEB_CLIENT_ID;
  const emit = () => listeners.forEach((fn) => { try { fn(info()); } catch (e) {} });
  const setStatus = (s, err) => { status = s; lastError = err || ''; emit(); };
  const info = () => ({ status, on: !!state.on, lastSync: state.lastSync || null, error: lastError, configured, platform: native ? 'android' : 'web' });

  const saveState = () => store.set(KEY_STATE, JSON.stringify(state));
  const saveBase = () => store.set(KEY_BASE, JSON.stringify(base));
  const saveTimes = () => store.set(KEY_TIMES, JSON.stringify(times));

  async function getToken(interactive) {
    if (token && Date.now() < tokenUntil) return token;
    if (!native && !token) {
      try { const c = JSON.parse(sessionStorage.getItem('ldc-sync:token') || 'null'); if (c && c.until > Date.now()) { token = c.t; tokenUntil = c.until; return token; } } catch (e) {}
    }
    token = native ? await nativeToken(interactive) : await webToken(interactive);
    if (native) tokenUntil = Date.now() + 45 * 60 * 1000;
    return token;
  }

  async function api(path, opts = {}, retry = true) {
    const t = await getToken(false);
    const res = await fetch('https://www.googleapis.com' + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
    if (res.status === 401 && retry) { token = null; tokenUntil = 0; try { sessionStorage.removeItem('ldc-sync:token'); } catch (e) {} return api(path, opts, false); }
    if (res.status === 401) throw Object.assign(new Error('login'), { code: 'login' });
    if (!res.ok) throw new Error('Drive ' + res.status);
    return res;
  }
  async function findFile() {
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const r = await (await api(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,version,modifiedTime)&orderBy=modifiedTime desc`)).json();
    return (r.files && r.files[0]) || null;
  }
  async function download(id) { return (await api(`/drive/v3/files/${id}?alt=media`)).json(); }
  async function upload(file, body) {
    const meta = file ? {} : { name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
    const boundary = 'ldc' + Date.now().toString(36);
    const payload = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n--${boundary}--`;
    const url = file ? `/upload/drive/v3/files/${file.id}?uploadType=multipart&fields=id,version` : '/upload/drive/v3/files?uploadType=multipart&fields=id,version';
    return (await api(url, { method: file ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: payload })).json();
  }

  const localDocs = () => { const o = {}; for (const [k, v] of docs.entries()) o[k] = JSON.parse(JSON.stringify(v)); return o; };
  const hasTx = (d) => Object.entries(d || {}).some(([k, v]) => /^tx\//.test(k) && v && Array.isArray(v.items) && v.items.length);

  async function syncOnce() {
    let file = await findFile();
    let remote = file ? await download(file.id) : null;
    const rdocs = (remote && remote.docs) || {}, rtimes = (remote && remote.times) || {};
    const local = localDocs();

    if (!base) {
      // First sync on this device.
      if (!remote) base = {};                                   // Drive empty: send what is here
      else if (!hasTx(local)) base = local;                     // nothing here yet: take the Drive
      else if (!hasTx(rdocs)) base = rdocs;                     // nothing in the Drive yet: keep this
      else if (state.choice === 'drive') base = local;          // person chose the Drive's data
      else if (state.choice === 'merge') base = {};             // person chose to join both
      else { setStatus('choose'); return false; }
    }

    const merged = {}, mtimes = {};
    for (const p of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(rdocs)])) {
      const v = merge3(base[p], local[p], rdocs[p], (times[p] || 0) >= (rtimes[p] || 0));
      if (v !== undefined) { merged[p] = v; mtimes[p] = Math.max(times[p] || 0, rtimes[p] || 0); }
    }

    // Bring this device up to date, without losing anything typed while syncing.
    for (const p of new Set([...Object.keys(local), ...Object.keys(merged)])) {
      const cur = docs.get(p);
      let next = merged[p];
      if (!same(cur, local[p])) { next = merge3(local[p], cur, merged[p], true); again = true; }
      if (!same(cur, next)) await applyDoc(p, next);
    }

    if (!remote || !same(rdocs, merged)) {
      if (file) {
        const now = await findFile();
        if (now && now.version !== file.version) { again = true; return true; }  // changed meanwhile: go again
      }
      await upload(file, { app: 'livro-de-contas', format: 1, kind: 'sync', exportedAt: new Date().toISOString(), docs: merged, times: mtimes });
    }
    base = merged; times = { ...times, ...mtimes };
    await saveBase(); await saveTimes();
    state.lastSync = new Date().toISOString(); state.firstDone = true; delete state.choice;
    await saveState();
    return true;
  }

  async function run() {
    if (!state.on || !configured) return;
    if (running) { again = true; return running; }
    running = (async () => {
      setStatus('syncing');
      try {
        let n = 0;
        do { again = false; if (!(await syncOnce())) return; } while (again && ++n < 3);
        setStatus('idle');
      } catch (e) {
        if (e && e.code === 'login') setStatus('login');
        else setStatus('error', navigator.onLine === false ? 'Sem internet. Sincroniza quando voltar a ligação.' : 'Não foi possível falar com o Google Drive.');
      } finally { running = null; }
    })();
    return running;
  }

  const api_ = {
    info,
    onChange(fn) { listeners.add(fn); fn(info()); return () => listeners.delete(fn); },
    // Called by the storage layer after every local change.
    touched(path) {
      times[path] = Date.now(); saveTimes();
      if (!state.on) return;
      clearTimeout(timer); timer = setTimeout(run, 1500);
    },
    async connect() {
      if (!configured) { setStatus('unconfigured'); return; }
      try { await getToken(true); } catch (e) { setStatus('off', 'Não foi possível entrar na conta Google. Tente outra vez.'); return; }
      state.on = true; await saveState();
      return run();
    },
    async choose(choice) { state.choice = choice; await saveState(); return run(); },
    async disconnect() {
      state = { on: false }; base = null; token = null; tokenUntil = 0;
      try { sessionStorage.removeItem('ldc-sync:token'); } catch (e) {}
      await store.remove(KEY_STATE); await store.remove(KEY_BASE);
      setStatus('off');
    },
    syncNow: () => run(),
    async init() {
      try { state = JSON.parse((await store.get(KEY_STATE)) || 'null') || { on: false }; } catch (e) { state = { on: false }; }
      try { base = JSON.parse((await store.get(KEY_BASE)) || 'null'); } catch (e) { base = null; }
      try { times = JSON.parse((await store.get(KEY_TIMES)) || 'null') || {}; } catch (e) { times = {}; }
      status = !configured ? 'unconfigured' : state.on ? 'idle' : 'off';
      run();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
      window.addEventListener('online', () => run());
      setInterval(() => { if (document.visibilityState === 'visible' && status !== 'login') run(); }, 2 * 60 * 1000);
    },
  };
  return api_;
}
