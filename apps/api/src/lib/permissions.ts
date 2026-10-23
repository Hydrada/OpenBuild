import type { Queryable } from "../db/db.js";
import { requestScope } from "./context.js";
import { TOOLS, type Tool, type ToolLevel } from "./tools.js";
import { HttpError } from "./errors.js";

export type OrgRole = "owner" | "admin" | "member";
/** subcontractor: external collaborator who sees drawings/specs and only the records assigned to them. */
export type ProjectRole = "manager" | "contributor" | "viewer" | "subcontractor";
/** Org owners/admins act as "admin" on every project in their org. */
export type EffectiveProjectRole = "admin" | ProjectRole;

/** read: see the project. record.write: create/edit records (tasks, RFIs, logs...). record.manage: settings, team, official answers, closing. */
export type ProjectAction = "read" | "read.full" | "record.write" | "record.manage" | "task.write" | "project.manage";

const ALLOWED: Record<ProjectAction, EffectiveProjectRole[]> = {
  read: ["admin", "manager", "contributor", "viewer", "subcontractor"],
  /** Everything internal to the project team: financials, logs, documents, activity, team list. */
  "read.full": ["admin", "manager", "contributor", "viewer"],
  "task.write": ["admin", "manager", "contributor"],
  "project.manage": ["admin", "manager"],
  "record.write": ["admin", "manager", "contributor"],
  "record.manage": ["admin", "manager"],
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
  assertKeyScope(orgId, "Organization not found");
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
  const rows = await q.query<{ id: string; org_id: string; name: string; org_role: OrgRole | null; project_role: ProjectRole | null; levels: Record<string, ToolLevel> | null }>(
    `SELECT p.id, p.org_id, p.name, om.role AS org_role, pm.role AS project_role, pt.levels
       FROM projects p
       LEFT JOIN org_memberships om ON om.org_id = p.org_id AND om.user_id = $2
       LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
       LEFT JOIN permission_templates pt ON pt.id = pm.template_id
      WHERE p.id = $1`,
    [projectId, userId],
  );
  const row = rows[0];
  const baseRole: EffectiveProjectRole | null = !row?.org_role
    ? null
    : row.org_role === "owner" || row.org_role === "admin"
      ? "admin"
      : row.project_role;
  if (!row || !baseRole) throw new HttpError(404, "Project not found");
  assertKeyScope(row.org_id, "Project not found");
  // Permission template: the member's level for this route's tool adjusts their role for this request only.
  const tool = requestScope.getStore()?.tool;
  const role = tool ? roleForTool(baseRole, row.levels?.[tool]) : baseRole;
  if (role === null) throw new HttpError(403, `You do not have access to ${TOOLS[tool!]}`);
  if (!projectRoleAllows(role, action)) throw new HttpError(403, "You do not have permission to do that");
  return { project: { id: row.id, org_id: row.org_id, name: row.name }, role };
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** API keys are bound to one organization; everything else 404s. */
function assertKeyScope(orgId: string, message: string) {
  const scope = requestScope.getStore();
  if (scope?.apiKeyOrgId && scope.apiKeyOrgId !== orgId) throw new HttpError(404, message);
}

export const isSubcontractor = (access: { role: EffectiveProjectRole }) => access.role === "subcontractor";

/** Subcontractors may only open records they are attached to (assignee, creator, reviewer...). */
export function assertVisibleToSub(access: { role: EffectiveProjectRole }, userId: string, related: (string | null | undefined)[], label = "Record") {
  if (access.role === "subcontractor" && !related.includes(userId)) throw new HttpError(404, `${label} not found`);
}

/** Roles that can create/edit records (contributor and up). */
export const canWriteRecords = (role: EffectiveProjectRole) => role === "admin" || role === "manager" || role === "contributor";

/**
 * A tool level on top of the project role. none: no access. read: as a viewer. standard: the role as is.
 * admin: as a manager (for that tool only). Company admins and subcontractors' visibility rules are never widened.
 */
export function roleForTool(role: EffectiveProjectRole, level: ToolLevel | undefined): EffectiveProjectRole | null {
  if (role === "admin" || !level || level === "standard") return role;
  if (level === "none") return null;
  if (role === "subcontractor") return role;
  return level === "read" ? "viewer" : "manager";
}

/** The caller's level for every tool on a project (company admins and members without a template: all standard). */
export async function toolLevels(q: Queryable, userId: string, projectId: string): Promise<Record<Tool, ToolLevel>> {
  const [r] = await q.query<{ levels: Record<string, ToolLevel> | null; org_role: OrgRole | null }>(
    `SELECT pt.levels, om.role AS org_role FROM projects p
       LEFT JOIN org_memberships om ON om.org_id = p.org_id AND om.user_id = $2
       LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
       LEFT JOIN permission_templates pt ON pt.id = pm.template_id WHERE p.id = $1`,
    [projectId, userId],
  );
  const admin = r?.org_role === "owner" || r?.org_role === "admin";
  return Object.fromEntries((Object.keys(TOOLS) as Tool[]).map((t) => [t, admin ? "standard" : r?.levels?.[t] ?? "standard"])) as Record<Tool, ToolLevel>;
}

export type { Tool };
