import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireOrgRole, requireProject } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";

/** One form field. `signature` captures a typed name plus the time it was signed. */
const field = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Keys are lowercase letters, digits and _"),
  label: z.string().trim().min(1).max(200),
  type: z.enum(["text", "textarea", "number", "date", "checkbox", "select", "signature"]),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});
export type FormField = z.infer<typeof field>;
const fieldList = z.array(field).min(1).max(100).superRefine((fs, ctx) => {
  const keys = new Set<string>();
  for (const f of fs) {
    if (keys.has(f.key)) ctx.addIssue({ code: "custom", message: `Duplicate field key "${f.key}"` });
    keys.add(f.key);
    if (f.type === "select" && !f.options?.length) ctx.addIssue({ code: "custom", message: `"${f.label}" needs options` });
  }
});

/** Validates answers against the form's fields; `complete` also enforces required fields. */
export function checkAnswers(fields: FormField[], answers: Record<string, unknown>, complete: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || v === "" || (f.type === "checkbox" && v === false) || (f.type === "signature" && !(v as { name?: string })?.name);
    if (empty) {
      if (complete && f.required) throw new HttpError(400, `"${f.label}" is required`);
      continue;
    }
    switch (f.type) {
      case "number": if (typeof v !== "number" && !(typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))) throw new HttpError(400, `"${f.label}" must be a number`); out[f.key] = Number(v); break;
      case "date": if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `"${f.label}" must be a date`); out[f.key] = v; break;
      case "checkbox": out[f.key] = v === true; break;
      case "select": if (!f.options!.includes(String(v))) throw new HttpError(400, `"${f.label}" must be one of the options`); out[f.key] = String(v); break;
      case "signature": {
        const name = String((v as { name: string }).name).trim().slice(0, 200);
        out[f.key] = { name, at: (v as { at?: string }).at ?? new Date().toISOString() };
        break;
      }
      default: out[f.key] = String(v).slice(0, f.type === "textarea" ? 20000 : 1000);
    }
  }
  return out;
}

export const formRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/form-templates", async (req) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    return db.query("SELECT id, name, fields, archived FROM form_templates WHERE org_id = $1 ORDER BY archived, name", [req.params.orgId]);
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/form-templates", async (req, reply) => {
    const user = requireUser(req);
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = z.object({ name: z.string().trim().min(1).max(200), fields: fieldList }).parse(req.body);
    if ((await db.query("SELECT 1 FROM form_templates WHERE org_id = $1 AND lower(name) = lower($2)", [req.params.orgId, b.name])).length) throw new HttpError(409, "A form with that name already exists");
    const [t] = await db.query<{ id: string }>("INSERT INTO form_templates (org_id, name, fields) VALUES ($1, $2, $3) RETURNING id", [req.params.orgId, b.name, JSON.stringify(b.fields)]);
    await audit(db, { orgId: req.params.orgId, actorId: user.id, action: "form_template.create", entityType: "form_template", entityId: t!.id, detail: { name: b.name } });
    return reply.code(201).send(t);
  });

  /** Editing a template never changes forms already started: each form keeps a copy of its fields. */
  app.patch<{ Params: { id: string } }>("/form-templates/:id", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, "Template not found");
    const [t] = await db.query<{ id: string; org_id: string }>("SELECT id, org_id FROM form_templates WHERE id = $1", [req.params.id]);
    if (!t) throw new HttpError(404, "Template not found");
    try { await requireOrgRole(db, user.id, t.org_id, ["owner", "admin"]); } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new HttpError(404, "Template not found");
      throw e;
    }
    const b = z.object({ name: z.string().trim().min(1).max(200).optional(), fields: fieldList.optional(), archived: z.boolean().optional() }).parse(req.body);
    await db.query("UPDATE form_templates SET name = coalesce($2, name), fields = coalesce($3::jsonb, fields), archived = coalesce($4, archived) WHERE id = $1",
      [t.id, b.name ?? null, b.fields ? JSON.stringify(b.fields) : null, b.archived ?? null]);
    return { ok: true };
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/forms", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT f.id, f.number, f.title, f.status, f.created_at, f.submitted_at, t.name AS template_name, u.name AS created_by_name
         FROM forms f JOIN form_templates t ON t.id = f.template_id LEFT JOIN users u ON u.id = f.created_by
        WHERE f.project_id = $1 ORDER BY f.number DESC`, [req.params.projectId]);
  });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/forms", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({ templateId: z.uuid(), title: z.string().trim().max(200).optional() }).parse(req.body);
    const row = await db.tx(async (q) => {
      const [t] = await q.query<{ name: string; fields: FormField[]; archived: boolean }>("SELECT name, fields, archived FROM form_templates WHERE id = $1 AND org_id = $2", [b.templateId, project.org_id]);
      if (!t || t.archived) throw new HttpError(400, "Form template not found");
      await q.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [project.id]);
      const [n] = await q.query<{ n: number }>("SELECT coalesce(max(number), 0)::int + 1 AS n FROM forms WHERE project_id = $1", [project.id]);
      const [f] = await q.query<{ id: string; number: number }>(
        "INSERT INTO forms (project_id, template_id, number, title, fields, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, number",
        [project.id, b.templateId, n!.n, b.title || t.name, JSON.stringify(t.fields), user.id]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "form.create", entityType: "form", entityId: f!.id, detail: { template: t.name } });
      return f!;
    });
    return reply.code(201).send(row);
  });

  app.get<{ Params: { id: string } }>("/forms/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "forms", req.params.id, user.id, "read.full", "Form");
    const [d] = await db.query(`SELECT f.*, s.name AS submitted_by_name, u.name AS created_by_name FROM forms f LEFT JOIN users s ON s.id = f.submitted_by LEFT JOIN users u ON u.id = f.created_by WHERE f.id = $1`, [row.id]);
    return { ...d, myRole: access.role };
  });

  /** Save answers (draft) or submit, which requires every required field and locks the form. */
  app.put<{ Params: { id: string } }>("/forms/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string; fields: FormField[] }>(db, "forms", req.params.id, user.id, "record.write", "Form");
    if (row.status === "submitted") throw new HttpError(409, "A submitted form cannot be changed");
    const b = z.object({ answers: z.record(z.string(), z.unknown()), submit: z.boolean().default(false) }).parse(req.body);
    const answers = checkAnswers(row.fields, b.answers, b.submit);
    await db.tx(async (q) => {
      await q.query(
        `UPDATE forms SET answers = $2, status = CASE WHEN $3 THEN 'submitted' ELSE status END,
                submitted_by = CASE WHEN $3 THEN $4::uuid ELSE submitted_by END, submitted_at = CASE WHEN $3 THEN now() ELSE submitted_at END WHERE id = $1`,
        [row.id, JSON.stringify(answers), b.submit, user.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: b.submit ? "form.submit" : "form.save", entityType: "form", entityId: row.id });
    });
    return { ok: true, answers };
  });
};
