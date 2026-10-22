import { useEffect, useState } from "react";

export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

/** Matches "/projects/:id" style patterns; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/");
  const s = path.replace(/\/$/, "").split("/");
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}
