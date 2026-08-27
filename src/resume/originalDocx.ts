const DB_NAME = 'resume-modifier-original-docx-v1';
const STORE = 'files';
const KEY = 'master';

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地 Word 缓存。'));
  });
}

export async function saveOriginalDocx(name: string, buffer: ArrayBuffer) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('无法保存原始 Word。'));
    tx.objectStore(STORE).put({ name, buffer }, KEY);
  });
  db.close();
}

export async function loadOriginalDocx() {
  const db = await openDb();
  const record = await new Promise<{ name: string; buffer: ArrayBuffer } | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve(request.result as { name: string; buffer: ArrayBuffer } | undefined);
    request.onerror = () => reject(request.error ?? new Error('无法读取原始 Word。'));
  });
  db.close();
  if (!record?.buffer) return null;
  return { name: String(record.name || '简历.docx'), buffer: record.buffer };
}
