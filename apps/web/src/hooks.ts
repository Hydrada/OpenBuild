import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

/** GET `path` and expose { data, error, reload }. A null path skips loading. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const hasData = useRef(false);
  hasData.current = data !== null;
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>("GET", path).then(
      (d) => live && (setData(d), setError(null)),
      // Offline: keep showing the last good data instead of replacing the screen with an error.
      (e) => live && !(e instanceof ApiError) && hasData.current ? undefined : live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    addEventListener("openbuild:synced", reload);
    return () => removeEventListener("openbuild:synced", reload);
  }, [reload]);
  return { data, error, reload };
}

/** Wraps a submit handler with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
