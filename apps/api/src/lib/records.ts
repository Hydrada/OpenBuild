import { z } from "zod";
import type { Queryable } from "../db/db.js";
import { HttpError } from "./errors.js";
import { isUuid, requireProject, type ProjectAccess, type ProjectAction } from "./permissions.js";

/** Tables that hang directly off a project and can be permission-checked by id. */
const PROJECT_TABLES = new Set([
  "tasks", "drawings", "folders", "documents", "spec_sections", "rfis", "submittals", "files",
  "daily_logs", "inspections", "punch_items", "observations", "incidents",
  "cost_codes", "contracts", "change_events", "change_orders", "invoices", "budget_lines", "schedule_items", "schedule_resources", "meetings", "timesheet_entries", "bid_packages", "bim_models",
  "correspondence", "direct_costs", "tm_tickets", "equipment",
  "action_plans", "action_plan_items", "warranties", "coordination_issues", "clash_runs", "lookahead_tasks", "crews", "compliance_documents", "lien_waivers", "forms",
]);

/** Loads a project-scoped row and checks the caller may perform `action` on its project. 404s hide other orgs' ids. */
export async function loadInProject<T extends { project_id: string }>(
  q: Queryable,
  table: string,
  id: string,
  userId: string,
  action: ProjectAction,
  label = "Record",
): Promise<{ row: T; access: ProjectAccess }> {
  if (!PROJECT_TABLES.has(table)) throw new Error(`loadInProject: unsupported table ${table}`);
  if (!isUuid(id)) throw new HttpError(404, `${label} not found`);
  const [row] = await q.query<T>(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!row) throw new HttpError(404, `${label} not found`);
  try {
    const access = await requireProject(q, userId, row.project_id, action);
    return { row, access };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new HttpError(404, `${label} not found`);
    throw e;
  }
}

/** Next per-project sequence number. Locks the project row so concurrent creators cannot collide. */
export async function nextNumber(q: Queryable, table: "rfis" | "submittals" | "punch_items" | "change_events" | "change_orders" | "contracts" | "invoices" | "bid_packages", projectId: string): Promise<number> {
  await q.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
  const [r] = await q.query<{ n: number }>(`SELECT coalesce(max(number), 0)::int + 1 AS n FROM ${table} WHERE project_id = $1`, [projectId]);
  return r!.n;
}

/** True when `userId` can see the project (org admin, or project member). Used to validate assignees/reviewers. */
export async function assertProjectMember(q: Queryable, projectId: string, userId: string, what = "Assignee"): Promise<void> {
  if (!isUuid(userId)) throw new HttpError(400, `${what} is not a member of this project`);
  const rows = await q.query(
    `SELECT 1 FROM projects p JOIN org_memberships om ON om.org_id = p.org_id AND om.user_id = $2
       LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.id = $1 AND (om.role IN ('owner','admin') OR pm.role IS NOT NULL)`,
    [projectId, userId],
  );
  if (!rows.length) throw new HttpError(400, `${what} is not a member of this project`);
}

/** Only whitelisted keys reach SQL; values are bound parameters starting at $2 ($1 is the row id). */
export function toSet(body: Record<string, unknown>, columns: Record<string, string>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of Object.entries(columns)) {
    if (body[key] === undefined) continue;
    values.push(body[key]);
    sets.push(`${col} = $${values.length + 1}`);
  }
  return { sets, values };
}

/**
 * Schema for a partial update: every field optional and **no defaults**. (zod's `.partial()` still applies
 * `.default()` values, so a PATCH that sends one field would silently reset the others.)
 */
export function editable<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([k, v]) => {
    const t = v as z.ZodType;
    return [k, (t instanceof z.ZodDefault ? (t.unwrap() as z.ZodType) : t).optional()];
  }));
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof S]: z.ZodOptional<S[K] extends z.ZodDefault<infer I> ? I : S[K]> }>;
}
