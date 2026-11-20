// Shared expenses between two people (like Splitwise), kept in Firestore.
//
// Only this one list is shared: everything else in each person's Livro de Contas stays
// on their own devices and in their own Google Drive. Anyone can create a group of two:
// the app gives an invitation code and the other person joins with it. The Firestore
// security rules (firestore.rules, pasted in the Firebase console) only let the members
// of a group read or write it; joining needs the group's secret code.
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
const KEY_GROUP = 'ldc-shared:group'; // { id, code, name } of the group this person is in
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
// Invitation code = group id (10) + secret (6), shown as XXXX-XXXX-XXXX-XXXX. No 0/O or 1/I.
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((x) => ABC[x % ABC.length]).join(''); };
export const formatInvite = (g) => (g.id + g.code).match(/.{1,4}/g).join('-');
const parseInvite = (s) => { const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return t.length === 16 ? { id: t.slice(0, 10), code: t.slice(10) } : null; };
const strs = (f) => ((f && f.arrayValue && f.arrayValue.values) || []).map((v) => v.stringValue);

export function createShared({ native, store, shareText }) {
  const configured = !!FIREBASE_API_KEY;
  const root = `projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
  let auth = null;            // { refresh, email }
  let idToken = null, idUntil = 0;
  let group = null;           // { id, code, name, members: [emails] }
  let items = [], members = [], at = null, queue = [];
  // Reads are counted per document, so after one full read only what changed since is fetched
  // (each write stamps the server time in field t). The group is re-read only every 10 minutes.
  let since = null, groupAt = 0;
  let status = 'off';         // off | nogroup | idle | loading | login | denied | error | unconfigured
  let lastError = '';
  let busy = null, timer = null, started = false;
  const listeners = new Set();

  const memberList = () => (group ? group.members : []).map((e) => members.find((m) => m.email === e) || { email: e, name: e.split('@')[0] });
  const info = () => ({ configured, status, error: lastError, email: auth ? auth.email : '', group: group ? { ...group, invite: formatInvite(group) } : null, items, members: memberList(), lastSync: at, pending: queue.length });
  const emit = () => listeners.forEach((fn) => { try { fn(info()); } catch (e) {} });
  const setStatus = (s, err) => { status = s; lastError = err || ''; emit(); };
  const saveCache = () => store.set(KEY_CACHE, JSON.stringify({ items, members, at, gid: group && group.id }));
  const saveQueue = () => store.set(KEY_QUEUE, JSON.stringify(queue));
  const saveGroup = () => (group ? store.set(KEY_GROUP, JSON.stringify(group)) : store.remove(KEY_GROUP));
  const gpath = () => `${root}/grupos/${group.id}`;

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
  async function call(method, url, body) {
    const t = await firebaseToken();
    const res = await fetch('https://firestore.googleapis.com/v1/' + url, { method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { idToken = null; throw loginErr(); }
    if (res.status === 403) throw Object.assign(new Error('denied'), { code: 'denied' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Firestore ' + res.status);
    return res.json();
  }
  async function listAll(col) {
    const out = []; let page = '';
    do {
      const j = await call('GET', `${gpath()}/${col}?pageSize=300${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
      if (!j) break;
      for (const d of j.documents || []) { const v = dec(d); if (v) out.push(v); }
      page = j.nextPageToken || '';
    } while (page);
    return out;
  }
  const commit = (writes) => call('POST', `${root}:commit`, { writes });
  const putDoc = (w) => commit([{ update: { name: `${gpath()}/${w.col}/${w.id}`, ...enc(w.data) }, updateTransforms: [{ fieldPath: 't', setToServerValue: 'REQUEST_TIME' }] }]);
  async function changedSince(col, ts) {
    const rows = await call('POST', `${gpath()}:runQuery`, { structuredQuery: {
      from: [{ collectionId: col }],
      where: { fieldFilter: { field: { fieldPath: 't' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: ts } } },
    } });
    const out = []; let readTime = null;
    for (const r of rows || []) { if (r.readTime) readTime = r.readTime; if (r.document) { const v = dec(r.document); if (v) out.push(v); } }
    return { out, readTime };
  }
  async function readGroup(id) {
    const d = await call('GET', `${root}/grupos/${id}`);
    if (!d) return null;
    const j = dec(d) || {};
    return { id, code: d.fields.code ? d.fields.code.stringValue : '', name: j.name || '', members: strs(d.fields.members) };
  }
  async function findMyGroup() {
    const rows = await call('POST', `${root}:runQuery`, { structuredQuery: {
      from: [{ collectionId: 'grupos' }],
      where: { fieldFilter: { field: { fieldPath: 'members' }, op: 'ARRAY_CONTAINS', value: { stringValue: auth.email } } },
      limit: 1,
    } });
    const d = (rows || []).find((r) => r.document);
    return d ? readGroup(d.document.name.split('/').pop()) : null;
  }
  async function flush() {
    while (queue.length && group) {
      const w = queue[0];
      if (w.gid !== group.id) { queue.shift(); continue; }
      await putDoc(w);
      queue.shift(); await saveQueue();
    }
  }
  function apply(w) {
    if (w.col === 'mov') { items = items.filter((x) => x.id !== w.data.id).concat([w.data]); }
    else if (w.col === 'membros') { members = members.filter((m) => m.email !== w.data.email).concat([w.data]); }
  }
  function resetData() { items = []; members = []; since = null; groupAt = 0; at = null; }

  async function refresh() {
    if (!configured || !auth) return;
    if (busy) return busy;
    busy = (async () => {
      try {
        if (!group) {
          const g = await findMyGroup();
          if (!g) { setStatus('nogroup'); return; }
          group = g; groupAt = Date.now(); resetData(); await saveGroup();
        }
        if (status !== 'idle') setStatus('loading');
        await flush();
        if (Date.now() - groupAt > 10 * 60000 || group.members.length < 2) {
          const g = await readGroup(group.id);
          if (!g || !g.members.includes(auth.email)) { group = null; resetData(); await saveGroup(); await saveCache(); setStatus('nogroup'); return; }
          group = g; groupAt = Date.now(); await saveGroup();
          members = await listAll('membros');
        }
        if (!since) {
          const started = new Date(Date.now() - 5 * 60000).toISOString();
          items = await listAll('mov'); members = await listAll('membros'); since = started;
        } else {
          const { out, readTime } = await changedSince('mov', since);
          const byId = new Map(items.map((x) => [x.id, x])); for (const x of out) byId.set(x.id, x); items = [...byId.values()];
          // a little overlap, so a write that lands at the same moment is never missed
          if (readTime) since = new Date(Date.parse(readTime) - 60000).toISOString();
        }
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
    if (!group) return;
    const w = { col, id: col === 'membros' ? safeId(id) : id, data, gid: group.id };
    queue = queue.filter((q) => !(q.col === w.col && q.id === w.id)).concat([w]);
    apply(w); await saveQueue(); await saveCache(); emit();
    refresh();
  }
  function schedule() {
    clearInterval(timer);
    // Every 20 s while the app is open, so a new expense from the other person shows up quickly.
    timer = setInterval(() => { if (document.visibilityState === 'visible' && group) refresh(); }, 20000);
  }
  const fail = (msg) => { setStatus(group ? 'idle' : 'nogroup', msg); return false; };

  return {
    info,
    onChange(fn) { listeners.add(fn); fn(info()); return () => listeners.delete(fn); },
    async start() {
      if (started) return; started = true;
      try { auth = JSON.parse((await store.get(KEY_AUTH)) || 'null'); } catch (e) { auth = null; }
      try { group = JSON.parse((await store.get(KEY_GROUP)) || 'null'); } catch (e) { group = null; }
      try { const c = JSON.parse((await store.get(KEY_CACHE)) || 'null'); if (c && group && c.gid === group.id) { items = c.items || []; members = c.members || []; at = c.at || null; } } catch (e) {}
      try { queue = JSON.parse((await store.get(KEY_QUEUE)) || '[]') || []; } catch (e) { queue = []; }
      status = !configured ? 'unconfigured' : !auth ? 'off' : group ? 'idle' : 'nogroup';
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
        auth = { refresh: j.refreshToken, email: j.email || '', name: name || '' };
        idToken = j.idToken; idUntil = Date.now() + (+j.expiresIn - 120) * 1000;
        await store.set(KEY_AUTH, JSON.stringify(auth));
        group = null; resetData(); await saveGroup();
        setStatus('loading'); await refresh(); schedule();
      } catch (e) {
        setStatus(auth ? status : 'off', e && e.code === 'login' ? 'O início de sessão na Google foi cancelado.' : 'Não foi possível entrar. ' + (e && e.message ? '(' + e.message + ')' : ''));
      }
    },
    async signOut() {
      auth = null; idToken = null; group = null; queue = []; resetData();
      await store.remove(KEY_AUTH); await store.remove(KEY_CACHE); await store.remove(KEY_QUEUE); await store.remove(KEY_GROUP);
      clearInterval(timer); setStatus('off');
    },
    // A new group with only me in it; the other person joins with the invitation code.
    async createGroup(name, myName) {
      if (!auth) return false;
      const g = { id: rnd(10), code: rnd(6), name: name || '', members: [auth.email] };
      try {
        await commit([{ update: { name: `${root}/grupos/${g.id}`, fields: {
          members: { arrayValue: { values: [{ stringValue: auth.email }] } }, code: { stringValue: g.code },
          j: { stringValue: JSON.stringify({ name: g.name, by: auth.email }) } } }, currentDocument: { exists: false } }]);
      } catch (e) { return fail(e && e.code === 'login' ? '' : 'Não foi possível criar o grupo. Tente outra vez.'); }
      group = g; groupAt = Date.now(); resetData(); await saveGroup(); await saveCache();
      await write('membros', auth.email, { email: auth.email, name: myName || auth.email.split('@')[0] });
      return true;
    },
    async joinGroup(invite, myName) {
      if (!auth) return false;
      const p = parseInvite(invite);
      if (!p) return fail('O código tem 16 letras e números, por exemplo K7PX-93QD-M2TA-8HWE.');
      try {
        await commit([{ update: { name: `${root}/grupos/${p.id}`, fields: { joinCode: { stringValue: p.code } } }, updateMask: { fieldPaths: ['joinCode'] },
          currentDocument: { exists: true },
          updateTransforms: [{ fieldPath: 'members', appendMissingElements: { values: [{ stringValue: auth.email }] } }] }]);
        const g = await readGroup(p.id);
        if (!g) throw Object.assign(new Error('denied'), { code: 'denied' });
        group = g; groupAt = Date.now(); resetData(); await saveGroup();
      } catch (e) { return fail(e && e.code === 'login' ? '' : 'Código errado, ou o grupo já tem duas pessoas.'); }
      await write('membros', auth.email, { email: auth.email, name: myName || auth.email.split('@')[0] });
      return true;
    },
    async leaveGroup() {
      if (!auth || !group) return;
      try { await commit([{ transform: { document: `${root}/grupos/${group.id}`, fieldTransforms: [{ fieldPath: 'members', removeAllFromArray: { values: [{ stringValue: auth.email }] } }] } }]); }
      catch (e) { fail('Não foi possível sair do grupo. Tente outra vez.'); return; }
      group = null; queue = []; resetData(); await saveGroup(); await saveQueue(); await saveCache(); setStatus('nogroup');
    },
    shareInvite: () => group && shareText(`Livro de Contas: para partilharmos despesas, abra o separador Partilhado, toque em "Tenho um código" e escreva ${formatInvite(group)}`),
    put: (item) => write('mov', item.id, item),
    putMany: async (list) => {
      if (!group) return;
      for (const it of list) { const w = { col: 'mov', id: it.id, data: it, gid: group.id }; queue = queue.filter((q) => !(q.col === 'mov' && q.id === it.id)).concat([w]); apply(w); }
      await saveQueue(); await saveCache(); emit(); return refresh();
    },
    setName: (name) => auth && write('membros', auth.email, { email: auth.email, name }),
    refresh,
  };
}
