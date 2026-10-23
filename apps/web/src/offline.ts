import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

/**
 * Offline outbox for field records (daily logs, punch items, observations, incidents, inspections).
 * Each create carries a client-generated `clientId`; the server treats replays of the same id as the
 * original record, so a request that reached the server before the connection dropped is never duplicated.
 */
interface Pending { clientId: string; method?: "POST" | "PATCH"; path: string; body: Record<string, unknown>; label: string; queuedAt: string; lastError?: string }

const KEY = "openbuild.outbox";
const listeners = new Set<() => void>();

function read(): Pending[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
}
function write(items: Pending[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
  listeners.forEach((l) => l());
}

const isNetworkError = (e: unknown) => !(e instanceof ApiError) || e.status === 502 || e.status === 503 || e.status === 504;

/** POSTs now if possible; on a network failure the record is queued and `queued: true` is returned. */
export async function createOrQueue<T>(path: string, body: Record<string, unknown>, label: string): Promise<{ queued: boolean; data?: T }> {
  const clientId = crypto.randomUUID();
  const payload = { ...body, clientId };
  if (navigator.onLine) {
    try {
      return { queued: false, data: await api<T>("POST", path, payload) };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  write([...read(), { clientId, path, body: payload, label, queuedAt: new Date().toISOString() }]);
  return { queued: true };
}

/**
 * Edits (PATCH / status POSTs) made offline are queued and replayed in order. They set values rather than
 * increment them, so replaying an edit that already reached the server is harmless; a 409 on replay means the
 * server is already in (or past) that state and the edit is dropped.
 */
export async function updateOrQueue<T>(method: "PATCH" | "POST", path: string, body: Record<string, unknown>, label: string): Promise<{ queued: boolean; data?: T }> {
  if (navigator.onLine) {
    try {
      return { queued: false, data: await api<T>(method, path, body) };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  write([...read(), { clientId: crypto.randomUUID(), method, path, body, label, queuedAt: new Date().toISOString() }]);
  return { queued: true };
}

let syncing = false;
/** Sends queued records in order. Validation errors stay in the queue with their message for the user to fix or discard. */
export async function syncOutbox(): Promise<{ sent: number; failed: number }> {
  if (syncing || !navigator.onLine) return { sent: 0, failed: 0 };
  syncing = true;
  let sent = 0;
  let failed = 0;
  try {
    for (const item of read()) {
      try {
        try {
          await api(item.method ?? "POST", item.path, item.body);
        } catch (e) {
          if (!(item.method && e instanceof ApiError && e.status === 409)) throw e;
        }
        write(read().filter((p) => p.clientId !== item.clientId));
        sent++;
      } catch (e) {
        if (isNetworkError(e)) break;
        failed++;
        write(read().map((p) => (p.clientId === item.clientId ? { ...p, lastError: (e as Error).message } : p)));
      }
    }
  } finally {
    syncing = false;
  }
  // Photos go after records so the items they attach to exist.
  try { if (navigator.onLine) sent += await syncPhotos(); } catch { /* IndexedDB unavailable */ }
  listeners.forEach((l) => l());
  // Let open screens refetch so synced records appear without a manual reload.
  if (sent) dispatchEvent(new Event("openbuild:synced"));
  return { sent, failed };
}

export function discard(clientId: string) {
  write(read().filter((p) => p.clientId !== clientId));
}

export function useOutbox() {
  const [items, setItems] = useState(read);
  const [photos, setPhotos] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => { setItems(read()); pendingPhotos().then((p) => setPhotos(p.length), () => {}); };
    update();
    const on = () => { setOnline(true); void syncOutbox(); };
    const off = () => setOnline(false);
    listeners.add(update);
    addEventListener("online", on);
    addEventListener("offline", off);
    addEventListener("storage", update);
    void syncOutbox();
    return () => { listeners.delete(update); removeEventListener("online", on); removeEventListener("offline", off); removeEventListener("storage", update); };
  }, []);
  return { items, online, photos };
}

// ---------- Offline photos ----------
// Files are too large for localStorage, so queued uploads live in IndexedDB: { id, projectId, entityType, entityId, file }.

interface PendingPhoto { id: string; projectId: string; entityType: string; entityId: string; name: string; type: string; blob: Blob; queuedAt: string }

function photoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("openbuild-offline", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("photos", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function photoStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await photoDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction("photos", mode).objectStore("photos"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export const pendingPhotos = () => photoStore<PendingPhoto[]>("readonly", (s) => s.getAll() as IDBRequest<PendingPhoto[]>);

async function uploadAndAttach(p: { projectId: string; entityType: string; entityId: string }, file: Blob, name: string) {
  const fd = new FormData();
  fd.append("file", file, name);
  const res = await fetch(`/api/projects/${p.projectId}/files`, { method: "POST", credentials: "same-origin", headers: { "x-openbuild-csrf": "1" }, body: fd });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? res.statusText);
  const stored = await res.json();
  await api("POST", "/attachments", { entityType: p.entityType, entityId: p.entityId, fileId: stored.id });
}

/** Uploads and attaches now, or keeps the photo on the device until the connection returns. */
export async function attachOrQueue(target: { projectId: string; entityType: string; entityId: string }, file: File): Promise<{ queued: boolean }> {
  if (navigator.onLine) {
    try {
      await uploadAndAttach(target, file, file.name);
      return { queued: false };
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  await photoStore("readwrite", (s) => s.put({ id: crypto.randomUUID(), ...target, name: file.name, type: file.type, blob: file, queuedAt: new Date().toISOString() }));
  listeners.forEach((l) => l());
  return { queued: true };
}

async function syncPhotos(): Promise<number> {
  let sent = 0;
  for (const p of await pendingPhotos()) {
    try {
      await uploadAndAttach(p, p.blob, p.name);
    } catch (e) {
      if (isNetworkError(e)) break;
      // Rejected (e.g. no longer permitted): drop it rather than retry forever.
    }
    await photoStore("readwrite", (s) => s.delete(p.id));
    sent++;
  }
  return sent;
}
