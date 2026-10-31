// Phone-side storage and file sharing for the Android app.
// Exposes window.LDC with the same small document API the page uses on claude.ai
// (doc(path).set/delete/onSnapshot, collection(name).onSnapshot), backed by
// Capacitor Preferences so every document is kept on the device.
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import seed from '../seed/default.json';

const PREFIX = 'ldc:';
const docs = new Map();          // path -> data
const docListeners = new Map();  // path -> Set(fn)
const colListeners = new Map();  // collection -> Set(fn)

const clone = (v) => JSON.parse(JSON.stringify(v));
const collectionOf = (path) => path.split('/').slice(0, -1).join('/');

function docSnap(path) {
  const data = docs.get(path);
  return { id: path.split('/').pop(), exists: data !== undefined, data: () => (data === undefined ? undefined : clone(data)), metadata: { fromCache: false, hasPendingWrites: false } };
}
function colSnap(col) {
  const list = [...docs.keys()].filter((p) => collectionOf(p) === col).sort().map(docSnap);
  return { docs: list, size: list.length, empty: !list.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
}
function notify(path) {
  (docListeners.get(path) || []).forEach((fn) => fn(docSnap(path)));
  const col = collectionOf(path);
  (colListeners.get(col) || []).forEach((fn) => fn(colSnap(col)));
}
function listen(map, key, fn, snap) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(fn);
  setTimeout(() => fn(snap()), 0);
  return () => map.get(key).delete(fn);
}

async function load() {
  const { keys } = await Preferences.keys();
  const mine = keys.filter((k) => k.startsWith(PREFIX));
  if (!mine.length) {
    // First run: start empty, with a base set of categories (no movements).
    for (const [path, data] of Object.entries(seed.docs)) {
      docs.set(path, data);
      await Preferences.set({ key: PREFIX + path, value: JSON.stringify(data) });
    }
    return;
  }
  for (const key of mine) {
    const { value } = await Preferences.get({ key });
    if (value != null) docs.set(key.slice(PREFIX.length), JSON.parse(value));
  }
}

const db = {
  doc(path) {
    return {
      id: path.split('/').pop(),
      path,
      async get() { return docSnap(path); },
      async set(data) {
        docs.set(path, clone(data));
        await Preferences.set({ key: PREFIX + path, value: JSON.stringify(data) });
        notify(path);
      },
      async delete() {
        docs.delete(path);
        await Preferences.remove({ key: PREFIX + path });
        notify(path);
      },
      onSnapshot(next) { return listen(docListeners, path, next, () => docSnap(path)); },
    };
  },
  collection(col) {
    return { path: col, onSnapshot(next) { return listen(colListeners, col, next, () => colSnap(col)); } };
  },
};

let ready = null;
async function openDb() {
  if (!ready) ready = load().then(() => db);
  return ready;
}

// Write a file (text, or bytes for .xlsx) to the app cache and open the Android
// share sheet (Google Drive, Gmail, Files...). In a desktop browser it downloads instead.
function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function saveFile(filename, data, mime) {
  if (!Capacitor.isNativePlatform()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: mime }));
    a.download = filename;
    a.click();
    return;
  }
  const opts = { path: filename, directory: Directory.Cache };
  const { uri } = typeof data === 'string'
    ? await Filesystem.writeFile({ ...opts, data, encoding: Encoding.UTF8 })
    : await Filesystem.writeFile({ ...opts, data: toBase64(data) });
  await Share.share({ title: filename, files: [uri], dialogTitle: 'Guardar ou enviar' });
}

window.LDC = { openDb, saveFile };
