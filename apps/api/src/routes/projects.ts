import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireProject } from "../lib/permissions.js";
import { editable } from "../lib/records.js";

type ProjectParams = { Params: { projectId: string } };

const projectPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  code: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["bidding", "active", "on_hold", "closed"]).optional(),
  startDate: z.iso.date().nullable().optional(),
  endDate: z.iso.date().nullable().optional(),
});

const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  status: z.enum(["open", "in_progress", "done"]).default("open"),
  assigneeId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
});

const PROJECT_COLUMNS: Record<string, string> = {
  name: "name", code: "code", address: "address", status: "status", startDate: "start_date", endDate: "end_date",
};
const TASK_COLUMNS: Record<string, string> = { title: "title", status: "status", assigneeId: "assignee_id", dueDate: "due_date" };

export const projectRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  app.get<ProjectParams>("/projects/:projectId", async (req) => {
    const user = requireUser(req);
    const { role } = await requireProject(db, user.id, req.params.projectId, "read");
    const [project] = await db.query("SELECT * FROM projects WHERE id = $1", [req.params.projectId]);
    return { ...project, myRole: role };
  });

  app.patch<ProjectParams>("/projects/:projectId", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "project.manage");
    const body = projectPatch.parse(req.body);
    const { sets, values } = toSet(body, PROJECT_COLUMNS);
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    return db.tx(async (q) => {
      const [row] = await q.query<{ start_date: string | null; end_date: string | null }>(
        `UPDATE projects SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
        [project.id, ...values],
      );
      if (row!.start_date && row!.end_date && row!.end_date < row!.start_date) throw new HttpError(400, "End date is before start date");
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "project.update", entityType: "project", entityId: project.id, detail: body });
      return row;
    });
  });

  app.get<ProjectParams>("/projects/:projectId/members", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "read.full");
    // Org owners/admins have implicit access and are listed with their org role.
    return db.query(
      `SELECT u.id, u.name, u.email,
              CASE WHEN om.role IN ('owner','admin') THEN 'admin' ELSE pm.role END AS role, om.company,
              pm.role AS project_role, om.role AS org_role, pm.template_id
         FROM org_memberships om JOIN users u ON u.id = om.user_id
         LEFT JOIN project_memberships pm ON pm.project_id = $1 AND pm.user_id = om.user_id
        WHERE om.org_id = $2 AND (om.role IN ('owner','admin') OR pm.role IS NOT NULL)
        ORDER BY u.name`,
      [project.id, project.org_id],
    );
  });

  app.put<{ Params: { projectId: string; userId: string } }>("/projects/:projectId/members/:userId", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "project.manage");
    const body = z.object({ role: z.enum(["manager", "contributor", "viewer", "subcontractor"]).nullable() }).parse(req.body);
    if (!isUuid(req.params.userId)) throw new HttpError(404, "Member not found");
    return db.tx(async (q) => {
      const inOrg = await q.query("SELECT 1 FROM org_memberships WHERE org_id = $1 AND user_id = $2", [project.org_id, req.params.userId]);
      if (!inOrg.length) throw new HttpError(404, "That user is not in this organization");
      if (body.role === null) {
        await q.query("DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2", [project.id, req.params.userId]);
      } else {
        await q.query(
          `INSERT INTO project_memberships (project_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [project.id, req.params.userId, body.role],
        );
      }
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: body.role ? "project_member.set" : "project_member.remove", entityType: "user", entityId: req.params.userId, detail: { role: body.role } });
      return { ok: true };
    });
  });

  app.get<ProjectParams>("/projects/:projectId/tasks", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.project_id = $1 ORDER BY (t.status = 'done'), t.due_date NULLS LAST, t.created_at`,
      [req.params.projectId],
    );
  });

  app.post<ProjectParams>("/projects/:projectId/tasks", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "task.write");
    const body = taskInput.parse(req.body);
    const task = await db.tx(async (q) => {
      if (body.assigneeId) await assertAssignable(q, project.id, body.assigneeId);
      const [t] = await q.query<{ id: string }>(
        `INSERT INTO tasks (project_id, title, status, assignee_id, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [project.id, body.title, body.status, body.assigneeId ?? null, body.dueDate ?? null, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "task.create", entityType: "task", entityId: t!.id, detail: { title: body.title } });
      return t;
    });
    return reply.code(201).send(task);
  });

  app.patch<{ Params: { taskId: string } }>("/tasks/:taskId", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.taskId)) throw new HttpError(404, "Task not found");
    const [t] = await db.query<{ project_id: string }>("SELECT project_id FROM tasks WHERE id = $1", [req.params.taskId]);
    if (!t) throw new HttpError(404, "Task not found");
    const { project } = await requireProject(db, user.id, t.project_id, "task.write");
    const body = editable(taskInput).parse(req.body);
    const { sets, values } = toSet(body, TASK_COLUMNS);
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    return db.tx(async (q) => {
      if (body.assigneeId) await assertAssignable(q, project.id, body.assigneeId);
      const [row] = await q.query(`UPDATE tasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, [req.params.taskId, ...values]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "task.update", entityType: "task", entityId: req.params.taskId, detail: body });
      return row;
    });
  });

  app.get<ProjectParams>("/projects/:projectId/activity", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at, u.name AS actor_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT 50`,
      [req.params.projectId],
    );
  });
};

/** Only whitelisted keys reach SQL; values are always bound parameters ($2..). */
function toSet(body: Record<string, unknown>, columns: Record<string, string>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of Object.entries(columns)) {
    if (body[key] === undefined) continue;
    values.push(body[key]);
    sets.push(`${col} = $${values.length + 1}`);
  }
  return { sets, values };
}

async function assertAssignable(q: import("../db/db.js").Queryable, projectId: string, userId: string) {
  const rows = await q.query(
    `SELECT 1 FROM projects p JOIN org_memberships om ON om.org_id = p.org_id AND om.user_id = $2
       LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
      WHERE p.id = $1 AND (om.role IN ('owner','admin') OR pm.role IS NOT NULL)`,
    [projectId, userId],
  );
  if (!rows.length) throw new HttpError(400, "Assignee is not a member of this project");
}
