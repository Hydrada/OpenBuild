import type { Queryable } from "../db/db.js";
import { HttpError } from "./errors.js";

export type OrgRole = "owner" | "admin" | "member";
export type ProjectRole = "manager" | "contributor" | "viewer";
/** Org owners/admins act as "admin" on every project in their org. */
export type EffectiveProjectRole = "admin" | ProjectRole;

export type ProjectAction = "read" | "task.write" | "project.manage";

const ALLOWED: Record<ProjectAction, EffectiveProjectRole[]> = {
  read: ["admin", "manager", "contributor", "viewer"],
  "task.write": ["admin", "manager", "contributor"],
  "project.manage": ["admin", "manager"],
};

export function projectRoleAllows(role: EffectiveProjectRole | null, action: ProjectAction): boolean {
  return role !== null && ALLOWED[action].includes(role);
}

export async function getOrgRole(q: Queryable, userId: string, orgId: string): Promise<OrgRole | null> {
  const rows = await q.query<{ role: OrgRole }>(
    "SELECT role FROM org_memberships WHERE user_id = $1 AND org_id = $2",
    [userId, orgId],
  );
  return rows[0]?.role ?? null;
}

export async function requireOrgRole(q: Queryable, userId: string, orgId: string, allowed: OrgRole[]): Promise<OrgRole> {
  const role = await getOrgRole(q, userId, orgId);
  // Non-members get 404 so organization ids cannot be probed.
  if (!role) throw new HttpError(404, "Organization not found");
  if (!allowed.includes(role)) throw new HttpError(403, "You do not have permission to do that");
  return role;
}

export interface ProjectAccess {
  project: { id: string; org_id: string; name: string };
  role: EffectiveProjectRole;
}

export async function requireProject(
  q: Queryable,
  userId: string,
  projectId: string,
  action: ProjectAction,
): Promise<ProjectAccess> {
  if (!isUuid(projectId)) throw new HttpError(404, "Project not found");
  const rows = await q.query<{ id: string; org_id: string; name: string; org_role: OrgRole | null; project_role: ProjectRole | null }>(
    `SELECT p.id, p.org_id, p.name, om.role AS org_role, pm.role AS project_role
       FROM projects p
       LEFT JOIN org_memberships om ON om.org_id = p.org_id AND om.user_id = $2
       LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.id = $1`,
    [projectId, userId],
  );
  const row = rows[0];
  const role: EffectiveProjectRole | null = !row?.org_role
    ? null
    : row.org_role === "owner" || row.org_role === "admin"
      ? "admin"
      : row.project_role;
  if (!row || !role) throw new HttpError(404, "Project not found");
  if (!projectRoleAllows(role, action)) throw new HttpError(403, "You do not have permission to do that");
  return { project: { id: row.id, org_id: row.org_id, name: row.name }, role };
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
