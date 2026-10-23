import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireOrgRole, requireProject, toolLevels } from "../lib/permissions.js";
import { TOOLS, type Tool } from "../lib/tools.js";

const levels = z.partialRecord(z.enum(Object.keys(TOOLS) as [Tool, ...Tool[]]), z.enum(["none", "read", "standard", "admin"]));

/** Company permission templates (per-tool levels) and their assignment to project members. */
export const permissionTemplateRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  app.get("/permission-tools", async (req) => {
    requireUser(req);
    return Object.entries(TOOLS).map(([key, label]) => ({ key, label }));
  });

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/permission-templates", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    return db.query(
      `SELECT t.id, t.name, t.levels, (SELECT count(*)::int FROM project_memberships m WHERE m.template_id = t.id) AS members
         FROM permission_templates t WHERE t.org_id = $1 ORDER BY t.name`, [req.params.orgId]);
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/permission-templates", async (req, reply) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = z.object({ name: z.string().trim().min(1).max(100), levels }).parse(req.body);
    if ((await db.query("SELECT 1 FROM permission_templates WHERE org_id = $1 AND lower(name) = lower($2)", [req.params.orgId, b.name])).length) throw new HttpError(409, "A template with that name already exists");
    const row = await db.tx(async (q) => {
      const [t] = await q.query<{ id: string }>("INSERT INTO permission_templates (org_id, name, levels) VALUES ($1, $2, $3) RETURNING id", [req.params.orgId, b.name, JSON.stringify(b.levels)]);
      await audit(q, { orgId: req.params.orgId, actorId: user.id, action: "permission_template.create", entityType: "permission_template", entityId: t!.id, detail: b });
      return t!;
    });
    return reply.code(201).send(row);
  });

  async function template(id: string, userId: string) {
    if (!isUuid(id)) throw new HttpError(404, "Template not found");
    const [t] = await db.query<{ id: string; org_id: string }>("SELECT id, org_id FROM permission_templates WHERE id = $1", [id]);
    if (!t) throw new HttpError(404, "Template not found");
    try { await requireOrgRole(db, userId, t.org_id, ["owner", "admin"]); } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, "Template not found");
      throw e;
    }
    return t;
  }

  app.patch<{ Params: { id: string } }>("/permission-templates/:id", async (req) => {
    const user = requireUser(req);
    const t = await template(req.params.id, user.id);
    const b = z.object({ name: z.string().trim().min(1).max(100).optional(), levels: levels.optional() }).parse(req.body);
    await db.tx(async (q) => {
      await q.query("UPDATE permission_templates SET name = coalesce($2, name), levels = coalesce($3::jsonb, levels) WHERE id = $1", [t.id, b.name ?? null, b.levels ? JSON.stringify(b.levels) : null]);
      await audit(q, { orgId: t.org_id, actorId: user.id, action: "permission_template.update", entityType: "permission_template", entityId: t.id, detail: b });
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/permission-templates/:id", async (req) => {
    const user = requireUser(req);
    const t = await template(req.params.id, user.id);
    await db.tx(async (q) => {
      await q.query("DELETE FROM permission_templates WHERE id = $1", [t.id]);
      await audit(q, { orgId: t.org_id, actorId: user.id, action: "permission_template.delete", entityType: "permission_template", entityId: t.id });
    });
    return { ok: true };
  });

  app.put<{ Params: { projectId: string; userId: string } }>("/projects/:projectId/members/:userId/template", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "project.manage");
    const b = z.object({ templateId: z.uuid().nullable() }).parse(req.body);
    if (!isUuid(req.params.userId)) throw new HttpError(404, "Member not found");
    if (b.templateId && !(await db.query("SELECT 1 FROM permission_templates WHERE id = $1 AND org_id = $2", [b.templateId, project.org_id])).length) throw new HttpError(400, "Template not found");
    const r = await db.tx(async (q) => {
      const rows = await q.query("UPDATE project_memberships SET template_id = $3 WHERE project_id = $1 AND user_id = $2 RETURNING user_id", [project.id, req.params.userId, b.templateId]);
      if (rows.length) await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "project_member.template", entityType: "user", entityId: req.params.userId, detail: b });
      return rows.length;
    });
    if (!r) throw new HttpError(404, "That person is not a project member (company admins always have full access)");
    return { ok: true };
  });

  /** The caller's own level per tool, so the client can hide tools set to "none". */
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/my-tools", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return toolLevels(db, user.id, req.params.projectId);
  });
};
