// Shared expenses between two people (like Splitwise), kept in Firestore.
//
// Only this one list is shared: everything else in each person's Livro de Contas stays
// on their own devices and in their own Google Drive. Who can read and write the group
// is decided by the Firestore security rules in the Firebase console (the two Gmail
// addresses live there, not in this public code).
//
// Sign-in: a Google access token with the "email" scope (from the same DriveAuth plugin
// on Android, from Google Identity Services in the browser) is exchanged once for a
// Firebase session. Firebase gives a refresh token, so the session lasts without asking
// again, on the phone and on the PC.
import { registerPlugin } from '@capacitor/core';
import { GOOGLE_WEB_CLIENT_ID, FIREBASE_API_KEY, FIREBASE_PROJECT } from './config.js';

const SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
const KEY_AUTH = 'ldc-shared:auth';    // { refresh, email }
const KEY_CACHE = 'ldc-shared:cache';  // { items, members, at }
const KEY_QUEUE = 'ldc-shared:queue';  // writes not sent yet (offline)
const GROUP = 'casa';
const DriveAuth = registerPlugin('DriveAuth');

const loginErr = () => Object.assign(new Error('login'), { code: 'login' });

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
async function googleToken(native) {
  if (native) {
    const res = await DriveAuth.authorize({ interactive: true, scopes: SCOPES });
    if (!res || !res.accessToken) throw loginErr();
    return res.accessToken;
  }
  await loadGis();
  return new Promise((ok, fail) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_WEB_CLIENT_ID,
      scope: SCOPES.join(' '),
      callback: (r) => (r && r.access_token ? ok(r.access_token) : fail(loginErr())),
      error_callback: () => fail(loginErr()),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

// Firestore REST: every document keeps the item as one JSON string (field j).
const enc = (obj) => ({ fields: { j: { stringValue: JSON.stringify(obj) } } });
const dec = (doc) => { try { return JSON.parse(doc.fields.j.stringValue); } catch (e) { return null; } };
const safeId = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '_');

export function createShared({ native, store }) {
  const configured = !!FIREBASE_API_KEY;
  const base = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/grupos/${GROUP}`;
  let auth = null;            // { refresh, email }
  let idToken = null, idUntil = 0;
  let items = [], members = [], at = null, queue = [];
  // Reads are counted per document, so after one full read only what changed since is fetched
  // (each write stamps the server time in field t). Members are re-read only every 10 minutes.
  let since = null, membersAt = 0;
  const root = `projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
  let status = 'off';         // off | idle | loading | login | denied | error | unconfigured
  let lastError = '';
  let busy = null, timer = null, started = false;
  const listeners = new Set();

  const info = () => ({ configured, status, error: lastError, email: auth ? auth.email : '', items, members, lastSync: at, pending: queue.length });
  const emit = () => listeners.forEach((fn) => { try { fn(info()); } catch (e) {} });
  const setStatus = (s, err) => { status = s; lastError = err || ''; emit(); };
  const saveCache = () => store.set(KEY_CACHE, JSON.stringify({ items, members, at }));
  const saveQueue = () => store.set(KEY_QUEUE, JSON.stringify(queue));

  async function firebaseToken() {
    if (idToken && Date.now() < idUntil) return idToken;
    if (!auth || !auth.refresh) throw loginErr();
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refresh),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw loginErr();
    if (!res.ok) throw new Error('token ' + res.status);
    const j = await res.json();
    idToken = j.id_token; idUntil = Date.now() + (+j.expires_in - 120) * 1000;
    if (j.refresh_token && j.refresh_token !== auth.refresh) { auth.refresh = j.refresh_token; await store.set(KEY_AUTH, JSON.stringify(auth)); }
    return idToken;
  }

  async function fs(path, opts = {}) {
    const t = await firebaseToken();
    const res = await fetch(base + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } });
    if (res.status === 401) { idToken = null; throw loginErr(); }
    if (res.status === 403) throw Object.assign(new Error('denied'), { code: 'denied' });
    if (!res.ok && res.status !== 404) throw new Error('Firestore ' + res.status);
    return res.status === 404 ? null : res.json();
  }
  async function listAll(col) {
    const out = []; let page = '';
    do {
      const j = await fs(`/${col}?pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
      if (!j) break;
      for (const d of j.documents || []) { const v = dec(d); if (v) out.push(v); }
      page = j.nextPageToken || '';
    } while (page);
    return out;
  }

  async function api(url, body) {
    const t = await firebaseToken();
    const res = await fetch('https://firestore.googleapis.com/v1/' + url, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status === 401) { idToken = null; throw loginErr(); }
    if (res.status === 403) throw Object.assign(new Error('denied'), { code: 'denied' });
    if (!res.ok) throw new Error('Firestore ' + res.status);
    return res.json();
  }
  const commit = (w) => api(`${root}:commit`, { writes: [{
    update: { name: `${root}/grupos/${GROUP}/${w.col}/${w.id}`, ...enc(w.data) },
    updateTransforms: [{ fieldPath: 't', setToServerValue: 'REQUEST_TIME' }],
  }] });
  async function changedSince(col, ts) {
    const rows = await api(`${root}/grupos/${GROUP}:runQuery`, { structuredQuery: {
      from: [{ collectionId: col }],
      where: { fieldFilter: { field: { fieldPath: 't' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: ts } } },
    } });
    const out = []; let readTime = null;
    for (const r of rows || []) { if (r.readTime) readTime = r.readTime; if (r.document) { const v = dec(r.document); if (v) out.push(v); } }
    return { out, readTime };
  }
  async function flush() {
    while (queue.length) {
      const w = queue[0];
      await commit(w);
      queue.shift(); await saveQueue();
    }
  }

  function apply(w) {
    if (w.col === 'mov') { items = items.filter((x) => x.id !== w.data.id).concat([w.data]); }
    else if (w.col === 'membros') { members = members.filter((m) => m.email !== w.data.email).concat([w.data]); }
  }

  async function refresh() {
    if (!configured || !auth) return;
    if (busy) return busy;
    busy = (async () => {
      if (status !== 'idle') setStatus('loading');
      try {
        await flush();
        if (!since) {
          const started = new Date(Date.now() - 5 * 60000).toISOString();
          items = await listAll('mov'); since = started;
        } else {
          const { out, readTime } = await changedSince('mov', since);
          const byId = new Map(items.map((x) => [x.id, x])); for (const x of out) byId.set(x.id, x); items = [...byId.values()];
          // a little overlap, so a write that lands at the same moment is never missed
          if (readTime) since = new Date(Date.parse(readTime) - 60000).toISOString();
        }
        if (Date.now() - membersAt > 10 * 60000 || members.length < 2) { members = await listAll('membros'); membersAt = Date.now(); }
        at = new Date().toISOString();
        for (const w of queue) apply(w);
        await saveCache();
        setStatus('idle');
      } catch (e) {
        if (e && e.code === 'login') setStatus('login');
        else if (e && e.code === 'denied') setStatus('denied');
        else setStatus('error', navigator.onLine === false ? 'Sem internet: mostra o que já estava guardado.' : 'Não foi possível falar com o servidor das despesas partilhadas.');
      } finally { busy = null; }
    })();
    return busy;
  }

  async function write(col, id, data) {
    const w = { col, id: col === 'membros' ? safeId(id) : id, data };
    queue = queue.filter((q) => !(q.col === w.col && q.id === w.id)).concat([w]);
    apply(w); await saveQueue(); await saveCache(); emit();
    refresh();
  }

  function schedule() {
    clearInterval(timer);
    // Every 20 s while the app is open, so a new expense from the other person shows up quickly.
    timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 20000);
  }

  return {
    info,
    onChange(fn) { listeners.add(fn); fn(info()); return () => listeners.delete(fn); },
    async start() {
      if (started) return; started = true;
      try { auth = JSON.parse((await store.get(KEY_AUTH)) || 'null'); } catch (e) { auth = null; }
      try { const c = JSON.parse((await store.get(KEY_CACHE)) || 'null'); if (c) { items = c.items || []; members = c.members || []; at = c.at || null; } } catch (e) {}
      try { queue = JSON.parse((await store.get(KEY_QUEUE)) || '[]') || []; } catch (e) { queue = []; }
      status = !configured ? 'unconfigured' : auth ? 'idle' : 'off';
      emit();
      if (!configured) return;
      refresh(); schedule();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
      window.addEventListener('online', () => refresh());
    },
    async signIn(name) {
      if (!configured) { setStatus('unconfigured'); return; }
      try {
        const g = await googleToken(native);
        const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postBody: 'access_token=' + encodeURIComponent(g) + '&providerId=google.com', requestUri: 'http://localhost', returnSecureToken: true, returnIdpCredential: true }),
        });
        const j = await res.json();
        if (!res.ok || !j.idToken) throw new Error((j.error && j.error.message) || 'signin');
        auth = { refresh: j.refreshToken, email: (j.email || '').toLowerCase() };
        idToken = j.idToken; idUntil = Date.now() + (+j.expiresIn - 120) * 1000;
        await store.set(KEY_AUTH, JSON.stringify(auth));
        await write('membros', auth.email, { email: auth.email, name: name || auth.email.split('@')[0] });
        schedule();
      } catch (e) {
        setStatus(auth ? status : 'off', e && e.code === 'login' ? 'O início de sessão na Google foi cancelado.' : 'Não foi possível entrar. ' + (e && e.message ? '(' + e.message + ')' : ''));
      }
    },
    async signOut() {
      auth = null; idToken = null; items = []; members = []; queue = []; since = null; membersAt = 0;
      await store.remove(KEY_AUTH); await store.remove(KEY_CACHE); await store.remove(KEY_QUEUE);
      clearInterval(timer); setStatus('off');
    },
    put: (item) => write('mov', item.id, item),
    putMany: async (list) => {
      for (const it of list) { const w = { col: 'mov', id: it.id, data: it }; queue = queue.filter((q) => !(q.col === 'mov' && q.id === it.id)).concat([w]); apply(w); }
      await saveQueue(); await saveCache(); emit(); return refresh();
    },
    setName: (name) => auth && write('membros', auth.email, { email: auth.email, name }),
    refresh,
  };
}
