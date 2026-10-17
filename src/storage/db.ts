/**
 * IndexedDB persistence. Each workspace (personal or demo) is stored as one
 * record with a revision number. Saves run in a single readwrite transaction
 * that checks the revision first, so a stale tab can never overwrite newer
 * data. Successful saves are announced to other tabs so they reload.
 */
import { emptyWorkspace, type Workspace } from '../lib/types';
import { validateWorkspace } from '../lib/validate';

export type WorkspaceKey = 'personal' | 'demo';

interface StoredRecord {
  key: WorkspaceKey;
  revision: number;
  savedAt: string;
  workspace: Workspace;
}

export interface LoadedWorkspace {
  workspace: Workspace;
  revision: number;
}

export class ConflictError extends Error {
  constructor() {
    super('This data was changed in another tab. The latest version has been loaded, so please review and try again.');
  }
}

const DB_NAME = 'check-my-check';
const STORE = 'workspaces';
const CHANNEL = 'check-my-check-sync';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support local storage for this app.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('Could not open browser storage.'));
      req.onblocked = () => reject(new Error('Browser storage is blocked by another open tab.'));
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

export async function loadWorkspace(key: WorkspaceKey): Promise<LoadedWorkspace> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const rec = req.result as StoredRecord | undefined;
      if (!rec) return resolve({ workspace: emptyWorkspace(), revision: 0 });
      const valid = validateWorkspace(rec.workspace);
      if (!valid.ok) return reject(new Error(`Saved data could not be read: ${valid.errors[0]}`));
      resolve({ workspace: valid.workspace, revision: rec.revision });
    };
    req.onerror = () => reject(req.error ?? new Error('Could not read saved data.'));
  });
}

/**
 * Save a workspace if the stored revision still matches expectedRevision.
 * Resolves with the new revision only after the transaction commits.
 */
export async function saveWorkspace(key: WorkspaceKey, workspace: Workspace, expectedRevision: number): Promise<number> {
  const db = await openDb();
  const revision = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let next = -1;
    let conflict = false;
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const current = (getReq.result as StoredRecord | undefined)?.revision ?? 0;
      if (current !== expectedRevision) {
        conflict = true;
        tx.abort();
        return;
      }
      next = current + 1;
      const rec: StoredRecord = { key, revision: next, savedAt: new Date().toISOString(), workspace };
      store.put(rec);
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(conflict ? new ConflictError() : tx.error ?? new Error('Saving was cancelled.'));
    tx.onerror = () => {
      /* handled by onabort */
    };
  });
  announce({ key, revision });
  return revision;
}

// ---------- Cross-tab sync ----------

interface SyncMessage {
  key: WorkspaceKey;
  revision: number;
}

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  channel ??= new BroadcastChannel(CHANNEL);
  return channel;
}

function announce(msg: SyncMessage) {
  try {
    getChannel()?.postMessage(msg);
  } catch {
    /* cross-tab notice is best effort; revision checks still protect data */
  }
}

/** Subscribe to saves made in other tabs. Returns an unsubscribe function. */
export function onExternalSave(handler: (msg: SyncMessage) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const listener = (e: MessageEvent<SyncMessage>) => handler(e.data);
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
