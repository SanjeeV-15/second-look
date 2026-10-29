// The closet lives in this browser (IndexedDB). Nothing here is sent to the server except when
// the user adds an item (to be tagged) or asks for a try-on.
const DB_NAME = 'youcam-closet';
const ITEMS = 'items';
const META = 'meta';

let dbPromise;
const memory = { items: new Map(), meta: new Map() };
export let persistent = true;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(ITEMS, { keyPath: 'id' });
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    // Private windows can block IndexedDB. Keep working for this visit, and say so in the UI.
    persistent = false;
    throw err;
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listItems() {
  try {
    const all = await run(ITEMS, 'readonly', (s) => s.getAll());
    return all.sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [...memory.items.values()].sort((a, b) => a.addedAt - b.addedAt);
  }
}

export async function putItem(item) {
  memory.items.set(item.id, item);
  try {
    await run(ITEMS, 'readwrite', (s) => s.put(item));
  } catch {
    /* kept in memory */
  }
}

export async function deleteItem(id) {
  memory.items.delete(id);
  try {
    await run(ITEMS, 'readwrite', (s) => s.delete(id));
  } catch {
    /* already removed from memory */
  }
}

export async function getMeta(key) {
  try {
    return await run(META, 'readonly', (s) => s.get(key));
  } catch {
    return memory.meta.get(key);
  }
}

export async function setMeta(key, value) {
  memory.meta.set(key, value);
  try {
    await run(META, 'readwrite', (s) => s.put(value, key));
  } catch {
    /* kept in memory */
  }
}

export async function clearAll() {
  memory.items.clear();
  memory.meta.clear();
  try {
    await run(ITEMS, 'readwrite', (s) => s.clear());
    await run(META, 'readwrite', (s) => s.clear());
  } catch {
    /* nothing stored */
  }
}
