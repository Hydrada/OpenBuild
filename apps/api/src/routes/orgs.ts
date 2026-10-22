import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireOrgRole } from "../lib/permissions.js";
import { newToken } from "../lib/security.js";

type OrgParams = { Params: { orgId: string } };

const projectInput = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().max(40).optional().nullable(),
  address: z.string().trim().max(500).optional().nullable(),
  status: z.enum(["bidding", "active", "on_hold", "closed"]).default("active"),
  startDate: z.iso.date().optional().nullable(),
  endDate: z.iso.date().optional().nullable(),
});

export const orgRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  app.addHook("preHandler", async (req) => {
    const orgId = (req.params as { orgId?: string }).orgId;
    if (orgId !== undefined && !isUuid(orgId)) throw new HttpError(404, "Organization not found");
  });

  app.get<OrgParams>("/orgs/:orgId/projects", async (req) => {
    const user = requireUser(req);
    const role = await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    const seeAll = role !== "member";
    return db.query(
      `SELECT p.id, p.name, p.code, p.address, p.status, p.start_date, p.end_date, p.created_at,
              (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') AS open_tasks
         FROM projects p
        WHERE p.org_id = $1
          AND ($3 OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = $2))
        ORDER BY p.created_at DESC`,
      [req.params.orgId, user.id, seeAll],
    );
  });

  app.post<OrgParams>("/orgs/:orgId/projects", async (req, reply) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const body = projectInput.parse(req.body);
    if (body.startDate && body.endDate && body.endDate < body.startDate) throw new HttpError(400, "End date is before start date");
    const project = await db.tx(async (q) => {
      const [p] = await q.query<{ id: string }>(
        `INSERT INTO projects (org_id, name, code, address, status, start_date, end_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.params.orgId, body.name, body.code ?? null, body.address ?? null, body.status, body.startDate ?? null, body.endDate ?? null, user.id],
      );
      await audit(q, { orgId: req.params.orgId, projectId: p!.id, actorId: user.id, action: "project.create", entityType: "project", entityId: p!.id, detail: { name: body.name } });
      return p!;
    });
    return reply.code(201).send(project);
  });

  app.get<OrgParams>("/orgs/:orgId/members", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    const members = await db.query(
      `SELECT u.id, u.name, u.email, m.role, m.created_at FROM org_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 ORDER BY u.name`,
      [req.params.orgId],
    );
    const invitations = await db.query(
      `SELECT i.id, i.email, i.org_role, i.project_role, p.name AS project_name, i.created_at, i.expires_at
         FROM invitations i LEFT JOIN projects p ON p.id = i.project_id
        WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.expires_at > now() ORDER BY i.created_at DESC`,
      [req.params.orgId],
    );
    return { members, invitations };
  });

  app.patch<{ Params: { orgId: string; userId: string } }>("/orgs/:orgId/members/:userId", async (req) => {
    const user = requireUser(req);
    const myRole = await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const body = z.object({ role: z.enum(["admin", "member"]) }).parse(req.body);
    if (req.params.userId === user.id) throw new HttpError(400, "You cannot change your own role");
    return db.tx(async (q) => {
      const [target] = await q.query<{ role: string }>(
        "SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2",
        [req.params.orgId, isUuid(req.params.userId) ? req.params.userId : null],
      );
      if (!target) throw new HttpError(404, "Member not found");
      if (target.role === "owner") throw new HttpError(403, "The owner's role cannot be changed");
      if (myRole === "admin" && (target.role === "admin" || body.role === "admin")) {
        throw new HttpError(403, "Only the owner can grant or revoke admin");
      }
      await q.query("UPDATE org_memberships SET role = $3 WHERE org_id = $1 AND user_id = $2", [req.params.orgId, req.params.userId, body.role]);
      await audit(q, { orgId: req.params.orgId, actorId: user.id, action: "member.role_change", entityType: "user", entityId: req.params.userId, detail: { from: target.role, to: body.role } });
      return { ok: true };
    });
  });

  app.post<OrgParams>("/orgs/:orgId/invitations", async (req, reply) => {
    const user = requireUser(req);
    const myRole = await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const body = z
      .object({
        email: z.string().trim().toLowerCase().pipe(z.email()),
        orgRole: z.enum(["admin", "member"]).default("member"),
        projectId: z.uuid().optional().nullable(),
        projectRole: z.enum(["manager", "contributor", "viewer"]).optional().nullable(),
      })
      .parse(req.body);
    if (body.orgRole === "admin" && myRole !== "owner") throw new HttpError(403, "Only the owner can invite admins");
    if (!!body.projectId !== !!body.projectRole) throw new HttpError(400, "projectId and projectRole must be given together");
    if (body.projectId) {
      const p = await db.query("SELECT 1 FROM projects WHERE id = $1 AND org_id = $2", [body.projectId, req.params.orgId]);
      if (!p.length) throw new HttpError(404, "Project not found");
    }
    const already = await db.query(
      "SELECT 1 FROM org_memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND lower(u.email) = $2",
      [req.params.orgId, body.email],
    );
    if (already.length && !body.projectId) throw new HttpError(409, "That person is already a member");
    const { token, hash } = newToken();
    const inv = await db.tx(async (q) => {
      const [row] = await q.query<{ id: string; expires_at: string }>(
        `INSERT INTO invitations (org_id, email, org_role, project_id, project_role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '7 days') RETURNING id, expires_at`,
        [req.params.orgId, body.email, body.orgRole, body.projectId ?? null, body.projectRole ?? null, hash, user.id],
      );
      await audit(q, { orgId: req.params.orgId, projectId: body.projectId, actorId: user.id, action: "invitation.create", entityType: "invitation", entityId: row!.id, detail: { email: body.email, orgRole: body.orgRole, projectRole: body.projectRole } });
      return row!;
    });
    // Email delivery is not implemented yet; the inviter shares this link (see docs/KNOWN_LIMITATIONS.md).
    return reply.code(201).send({ id: inv.id, expiresAt: inv.expires_at, acceptPath: `/invite/${token}` });
  });

  app.get<OrgParams>("/orgs/:orgId/dashboard", async (req) => {
    const user = requireUser(req);
    const role = await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    const seeAll = role !== "member";
    const scope = `p.org_id = $1 AND ($3 OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.project_id = p.id AND pm.user_id = $2))`;
    const args = [req.params.orgId, user.id, seeAll];
    const [byStatus, taskStats, myTasks, activity] = await Promise.all([
      db.query(`SELECT p.status, count(*)::int AS count FROM projects p WHERE ${scope} GROUP BY p.status`, args),
      db.query(
        `SELECT count(*) FILTER (WHERE t.status <> 'done')::int AS open,
                count(*) FILTER (WHERE t.status <> 'done' AND t.due_date < current_date)::int AS overdue,
                count(*) FILTER (WHERE t.status = 'done')::int AS done
           FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${scope}`,
        args,
      ),
      db.query(
        `SELECT t.id, t.title, t.status, t.due_date, p.id AS project_id, p.name AS project_name
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE ${scope} AND t.assignee_id = $2 AND t.status <> 'done'
          ORDER BY t.due_date NULLS LAST, t.created_at LIMIT 20`,
        args,
      ),
      db.query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail, a.created_at, a.project_id, u.name AS actor_name, p.name AS project_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN projects p ON p.id = a.project_id
          WHERE a.org_id = $1 AND (a.project_id IS NULL AND $3 OR a.project_id IN (SELECT p.id FROM projects p WHERE ${scope}))
          ORDER BY a.id DESC LIMIT 25`,
        args,
      ),
    ]);
    return { role, projectsByStatus: byStatus, tasks: taskStats[0], myTasks, activity };
  });

  app.get<OrgParams & { Querystring: { before?: string } }>("/orgs/:orgId/audit", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const before = /^\d+$/.test(req.query.before ?? "") ? req.query.before : null;
    return db.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.project_id, a.detail, a.created_at, u.name AS actor_name, u.email AS actor_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.org_id = $1 AND ($2::bigint IS NULL OR a.id < $2::bigint)
        ORDER BY a.id DESC LIMIT 100`,
      [req.params.orgId, before],
    );
  });
};
