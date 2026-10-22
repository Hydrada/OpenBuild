export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-openbuild-csrf": "1" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const issue = data?.issues?.[0];
    throw new ApiError(res.status, issue ? `${issue.path || "Input"}: ${issue.message}` : data?.error ?? res.statusText);
  }
  return data as T;
}

export interface Me {
  user: { id: string; email: string; name: string };
  orgs: { id: string; name: string; role: "owner" | "admin" | "member" }[];
}

export const STATUS_LABEL: Record<string, string> = {
  bidding: "Bidding", active: "Active", on_hold: "On hold", closed: "Closed",
  open: "Open", in_progress: "In progress", done: "Done",
};

export function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString();
}
