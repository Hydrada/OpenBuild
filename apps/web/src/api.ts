export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const issue = data?.issues?.[0];
    throw new ApiError(res.status, issue ? `${issue.path || "Input"}: ${issue.message}` : data?.error ?? res.statusText);
  }
  return data as T;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-openbuild-csrf": "1" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : method !== "GET" && method !== "DELETE" ? "{}" : undefined,
  });
  return parse<T>(res);
}

/** multipart/form-data POST with text fields and one optional file. */
export async function upload<T = any>(path: string, fields: Record<string, string | null | undefined>, file?: File | null): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && v !== "") fd.append(k, v);
  if (file) fd.append("file", file, file.name);
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: { "x-openbuild-csrf": "1" }, body: fd });
  return parse<T>(res);
}

export interface Me {
  user: { id: string; email: string; name: string; mfaEnabled?: boolean };
  orgs: { id: string; name: string; role: "owner" | "admin" | "member" }[];
}

export const STATUS_LABEL: Record<string, string> = {
  bidding: "Bidding", active: "Active", on_hold: "On hold", closed: "Closed",
  open: "Open", in_progress: "In progress", done: "Done", draft: "Draft", answered: "Answered",
  in_review: "In review", approved: "Approved", approved_as_noted: "Approved as noted", revise_resubmit: "Revise & resubmit",
  rejected: "Rejected", pending: "Pending", skipped: "Skipped", signed: "Signed", completed: "Completed",
  ready_for_review: "Ready for review", investigating: "Investigating", submitted: "Submitted", paid: "Paid",
  void: "Void", complete: "Complete", terminated: "Terminated", pass: "Pass", fail: "Fail", na: "N/A",
  low: "Low", medium: "Medium", high: "High", scheduled: "Scheduled", minutes_published: "Minutes published",
};

export const label = (v: string | null | undefined) => (v ? STATUS_LABEL[v] ?? v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");

export function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString();
}

export function fmtDateTime(d: string | null | undefined) {
  return d ? new Date(d).toLocaleString() : "—";
}

/** Formats a decimal string with thousands separators without converting it to a float. */
export function fmtMoney(v: string | null | undefined) {
  if (v === null || v === undefined || v === "") return "—";
  const neg = v.startsWith("-");
  const [int = "0", frac = "00"] = v.replace("-", "").split(".");
  return `${neg ? "-" : ""}$${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac.padEnd(2, "0").slice(0, 2)}`;
}

export function fmtBytes(n: number | string) {
  const b = Number(n);
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

export const today = () => new Date().toLocaleDateString("en-CA");

/** Empty strings become null so optional API fields are cleared rather than rejected. */
export function nullify<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === "" ? null : v])) as T;
}
