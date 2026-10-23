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
  // Let open screens refetch so synced records appear without a manual reload.
  if (sent) dispatchEvent(new Event("openbuild:synced"));
  return { sent, failed };
}

export function discard(clientId: string) {
  write(read().filter((p) => p.clientId !== clientId));
}

export function useOutbox() {
  const [items, setItems] = useState(read);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setItems(read());
    const on = () => { setOnline(true); void syncOutbox(); };
    const off = () => setOnline(false);
    listeners.add(update);
    addEventListener("online", on);
    addEventListener("offline", off);
    addEventListener("storage", update);
    void syncOutbox();
    return () => { listeners.delete(update); removeEventListener("online", on); removeEventListener("offline", off); removeEventListener("storage", update); };
  }, []);
  return { items, online };
}
