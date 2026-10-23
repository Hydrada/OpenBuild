import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { toCsv } from "../lib/finance.js";
import { assertVisibleToSub, isUuid, requireOrgRole, requireProject, type ProjectAccess } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, nextNumber } from "../lib/records.js";
import { newToken, sha256 } from "../lib/security.js";
import { isPdf, readUpload, storeFile } from "../lib/uploads.js";


const COMMENTABLE = {
  rfi: { table: "rfis", related: ["assignee_id", "created_by"] },
  submittal: { table: "submittals", related: ["created_by"], array: "reviewer_ids" },
  punch_item: { table: "punch_items", related: ["assignee_id", "created_by"] },
  observation: { table: "observations", related: ["assignee_id", "created_by"] },
  task: { table: "tasks", related: null },
  document: { table: "documents", related: null },
  drawing: { table: "drawings", related: null },
  daily_log: { table: "daily_logs", related: null },
  inspection: { table: "inspections", related: null },
  incident: { table: "incidents", related: null },
  change_event: { table: "change_events", related: null },
  change_order: { table: "change_orders", related: null },
  invoice: { table: "invoices", related: null },
  meeting: { table: "meetings", related: null },
  correspondence: { table: "correspondence", related: null },
  tm_ticket: { table: "tm_tickets", related: null },
} as const;
type Commentable = keyof typeof COMMENTABLE;

export const collabRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db, storage } = config;

  /** Loads a commentable record and applies the subcontractor/internal visibility rules. */
  async function loadVisible(type: Commentable, id: string, userId: string): Promise<{ row: Record<string, unknown> & { project_id: string }; access: ProjectAccess }> {
    const def = COMMENTABLE[type];
    const { row, access } = await loadInProject<Record<string, unknown> & { project_id: string }>(db, def.table, id, userId, def.related || type === "drawing" ? "read" : "read.full");
    if (def.related) {
      const related = def.related.map((c) => row[c] as string | null);
      if ("array" in def) related.push(...((row[def.array] as string[]) ?? []));
      assertVisibleToSub(access, userId, related);
    }
    return { row, access };
  }

  // ---------- Comments & mentions ----------

  app.get<{ Querystring: { entityType?: string; entityId?: string } }>("/comments", async (req) => {
    const user = requireUser(req);
    const q = z.object({ entityType: z.enum(Object.keys(COMMENTABLE) as [Commentable]), entityId: z.uuid() }).parse(req.query);
    await loadVisible(q.entityType, q.entityId, user.id);
    return db.query(
      `SELECT c.id, c.body, c.created_at, c.author_id, u.name AS author_name FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.entity_type = $1 AND c.entity_id = $2 ORDER BY c.created_at`,
      [q.entityType, q.entityId],
    );
  });

  app.post("/comments", async (req, reply) => {
    const user = requireUser(req);
    const b = z.object({
      entityType: z.enum(Object.keys(COMMENTABLE) as [Commentable]),
      entityId: z.uuid(),
      body: z.string().trim().min(1).max(10000),
      mentionIds: z.array(z.uuid()).max(20).default([]),
    }).parse(req.body);
    const { row, access } = await loadVisible(b.entityType, b.entityId, user.id);
    const c = await db.tx(async (q) => {
      for (const m of b.mentionIds) await assertProjectMember(q, row.project_id, m, "Mentioned person");
      const [comment] = await q.query<{ id: string }>(
        `INSERT INTO comments (project_id, entity_type, entity_id, body, author_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [row.project_id, b.entityType, b.entityId, b.body, user.id],
      );
      const label = b.entityType.replace(/_/g, " ");
      const link = `/${COMMENTABLE[b.entityType].table}/${b.entityId}`;
      await config.notify(q, b.mentionIds, { kind: "mention", title: `${user.name} mentioned you on a ${label}: "${b.body.slice(0, 80)}"`, link, projectId: row.project_id, actorId: user.id });
      const owners = [row.created_by as string | null, (row.assignee_id as string | null) ?? null].filter((x) => x && !b.mentionIds.includes(x));
      await config.notify(q, owners, { kind: "comment", title: `${user.name} commented on a ${label}`, link, projectId: row.project_id, actorId: user.id });
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "comment.create", entityType: b.entityType, entityId: b.entityId, detail: { mentions: b.mentionIds.length } });
      return comment;
    });
    return reply.code(201).send(c);
  });

  // ---------- Subcontractor / collaborator portal ----------

  /** Everything assigned to me across all projects — the home page for subcontractors. */
  app.get("/me/work", async (req) => {
    const user = requireUser(req);
    const [rfis, punch, observations, approvals, tasks] = await Promise.all([
      db.query(`SELECT r.id, r.number, r.subject AS title, r.status, r.due_date, p.id AS project_id, p.name AS project_name FROM rfis r JOIN projects p ON p.id = r.project_id WHERE r.assignee_id = $1 AND r.status = 'open' ORDER BY r.due_date NULLS LAST`, [user.id]),
      db.query(`SELECT x.id, x.number, x.title, x.status, x.due_date, p.id AS project_id, p.name AS project_name FROM punch_items x JOIN projects p ON p.id = x.project_id WHERE x.assignee_id = $1 AND x.status = 'open' ORDER BY x.due_date NULLS LAST`, [user.id]),
      db.query(`SELECT x.id, x.title, x.severity, x.status, x.due_date, p.id AS project_id, p.name AS project_name FROM observations x JOIN projects p ON p.id = x.project_id WHERE x.assignee_id = $1 AND x.status = 'open' ORDER BY x.due_date NULLS LAST`, [user.id]),
      db.query(
        `SELECT s.id, s.entity_type, s.entity_id FROM approval_steps s WHERE s.approver_id = $1 AND s.status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM approval_steps e WHERE e.entity_type = s.entity_type AND e.entity_id = s.entity_id AND e.round = s.round AND e.seq < s.seq AND e.status = 'pending')`,
        [user.id],
      ),
      db.query(`SELECT t.id, t.title, t.status, t.due_date, p.id AS project_id, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.assignee_id = $1 AND t.status <> 'done' ORDER BY t.due_date NULLS LAST`, [user.id]),
    ]);
    return { rfis, punch, observations, approvals: approvals.length, tasks };
  });

  // ---------- API keys ----------

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/api-keys", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    return db.query(
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.expires_at, k.revoked_at, u.name AS owner_name
         FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.org_id = $1 ORDER BY k.created_at DESC`,
      [req.params.orgId],
    );
  });

  /** The key acts as the creating admin, only within this organization. The secret is shown once. */
  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/api-keys", async (req, reply) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = z.object({ name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(3650).optional() }).parse(req.body);
    const { token } = newToken();
    const secret = `ob_${token}`;
    const [k] = await db.query<{ id: string }>(
      `INSERT INTO api_keys (org_id, user_id, name, prefix, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END) RETURNING id`,
      [req.params.orgId, user.id, b.name, secret.slice(0, 10), sha256(secret), b.expiresInDays ?? null],
    );
    await audit(db, { orgId: req.params.orgId, actorId: user.id, action: "api_key.create", entityType: "api_key", entityId: k!.id, detail: { name: b.name } });
    return reply.code(201).send({ id: k!.id, secret });
  });

  app.delete<{ Params: { orgId: string; id: string } }>("/orgs/:orgId/api-keys/:id", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId) || !isUuid(req.params.id)) throw new HttpError(404, "Key not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const r = await db.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING id", [req.params.id, req.params.orgId]);
    if (!r.length) throw new HttpError(404, "Key not found");
    await audit(db, { orgId: req.params.orgId, actorId: user.id, action: "api_key.revoke", entityType: "api_key", entityId: req.params.id });
    return { ok: true };
  });

  // ---------- External document tools (OpenDraft, Acrobat alternative) ----------

  /** Mints a 2-hour capability: download this revision's PDF and upload one marked-up copy. */
  app.post<{ Params: { id: string } }>("/drawing-revisions/:id/tool-session", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, "Revision not found");
    const [rev] = await db.query<{ drawing_id: string }>("SELECT drawing_id FROM drawing_revisions WHERE id = $1", [req.params.id]);
    if (!rev) throw new HttpError(404, "Revision not found");
    await loadInProject(db, "drawings", rev.drawing_id, user.id, "record.write", "Revision");
    const b = z.object({ tool: z.string().trim().min(1).max(40) }).parse(req.body);
    const tool = config.documentTools.find((t) => t.id === b.tool);
    if (!tool) throw new HttpError(400, "Unknown document tool");
    const { token, hash } = newToken();
    await db.query(`INSERT INTO tool_tokens (token_hash, revision_id, user_id, tool, expires_at) VALUES ($1, $2, $3, $4, now() + interval '2 hours')`, [hash, req.params.id, user.id, tool.id]);
    const origin = `${req.protocol}://${req.host}`;
    const downloadUrl = `${origin}/api/tool/${token}/file`;
    const uploadUrl = `${origin}/api/tool/${token}/markup`;
    const [f] = await db.query<{ name: string }>("SELECT f.name FROM drawing_revisions r JOIN files f ON f.id = r.file_id WHERE r.id = $1", [req.params.id]);
    const launchUrl = tool.urlTemplate
      ? tool.urlTemplate.replace("{downloadUrl}", encodeURIComponent(downloadUrl)).replace("{uploadUrl}", encodeURIComponent(uploadUrl)).replace("{name}", encodeURIComponent(f!.name))
      : null;
    return { downloadUrl, uploadUrl, launchUrl, expiresInSeconds: 7200 };
  });

  async function findToolToken(token: string) {
    const [t] = await db.query<{ revision_id: string; user_id: string; tool: string; expired: boolean; uploaded_at: string | null; file_id: string; drawing_id: string }>(
      `SELECT t.revision_id, t.user_id, t.tool, t.expires_at < now() AS expired, t.uploaded_at, r.file_id, r.drawing_id
         FROM tool_tokens t JOIN drawing_revisions r ON r.id = t.revision_id WHERE t.token_hash = $1`,
      [sha256(token)],
    );
    if (!t || t.expired) throw new HttpError(404, "Link expired or not found");
    return t;
  }

  app.get<{ Params: { token: string } }>("/tool/:token/file", async (req, reply) => {
    const t = await findToolToken(req.params.token);
    const [f] = await db.query<{ storage_key: string; name: string; size: string }>("SELECT storage_key, name, size FROM files WHERE id = $1", [t.file_id]);
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Length", f!.size);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f!.name)}`);
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.send(await storage.get(f!.storage_key));
  });

  app.post<{ Params: { token: string } }>("/tool/:token/markup", async (req, reply) => {
    const t = await findToolToken(req.params.token);
    if (t.uploaded_at) throw new HttpError(410, "A markup was already uploaded with this link");
    // The token's user must still have write access to the project.
    const { row: drawing, access } = await loadInProject(db, "drawings", t.drawing_id, t.user_id, "record.write", "Revision");
    const up = await readUpload(req);
    if (!up.file || !isPdf(up.file.data)) throw new HttpError(400, "Upload the marked-up PDF");
    const id = await db.tx(async (q) => {
      const claimed = await q.query("UPDATE tool_tokens SET uploaded_at = now() WHERE token_hash = $1 AND uploaded_at IS NULL RETURNING 1", [sha256(req.params.token)]);
      if (!claimed.length) throw new HttpError(410, "A markup was already uploaded with this link");
      const file = await storeFile(q, storage, { orgId: access.project.org_id, projectId: drawing.project_id, userId: t.user_id, file: up.file! });
      const [m] = await q.query<{ id: string }>(`INSERT INTO markup_sets (revision_id, file_id, tool, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [t.revision_id, file.id, t.tool, up.fields.note?.slice(0, 1000) || null, t.user_id]);
      await audit(q, { orgId: access.project.org_id, projectId: drawing.project_id, actorId: t.user_id, action: "drawing.markup", entityType: "drawing", entityId: t.drawing_id, detail: { tool: t.tool, via: "tool-link" } });
      return m!.id;
    });
    reply.header("Access-Control-Allow-Origin", "*");
    return reply.code(201).send({ id });
  });

  // ---------- Custom fields ----------

  const ENTITY_TABLE = { project: "projects", rfi: "rfis", submittal: "submittals", punch_item: "punch_items", observation: "observations", task: "tasks" } as const;
  type CfEntity = keyof typeof ENTITY_TABLE;

  app.get<{ Params: { orgId: string }; Querystring: { entityType?: string } }>("/orgs/:orgId/custom-fields", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    return db.query(
      `SELECT id, entity_type, key, label, type, options, required FROM custom_field_defs WHERE org_id = $1 AND ($2::text IS NULL OR entity_type = $2) ORDER BY entity_type, created_at`,
      [req.params.orgId, req.query.entityType ?? null],
    );
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/custom-fields", async (req, reply) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = z.object({
      entityType: z.enum(Object.keys(ENTITY_TABLE) as [CfEntity]),
      key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, "Key: lowercase letters, digits, underscores"),
      label: z.string().trim().min(1).max(100),
      type: z.enum(["text", "number", "date", "select", "boolean"]),
      options: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
      required: z.boolean().default(false),
    }).parse(req.body);
    if (b.type === "select" && !b.options.length) throw new HttpError(400, "A select field needs options");
    const exists = await db.query("SELECT 1 FROM custom_field_defs WHERE org_id = $1 AND entity_type = $2 AND key = $3", [req.params.orgId, b.entityType, b.key]);
    if (exists.length) throw new HttpError(409, "A field with that key already exists");
    const [f] = await db.query(
      `INSERT INTO custom_field_defs (org_id, entity_type, key, label, type, options, required) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.orgId, b.entityType, b.key, b.label, b.type, JSON.stringify(b.options), b.required],
    );
    await audit(db, { orgId: req.params.orgId, actorId: user.id, action: "custom_field.create", entityType: "custom_field", entityId: (f as { id: string }).id, detail: b });
    return reply.code(201).send(f);
  });

  app.delete<{ Params: { orgId: string; id: string } }>("/orgs/:orgId/custom-fields/:id", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId) || !isUuid(req.params.id)) throw new HttpError(404, "Field not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const r = await db.query("DELETE FROM custom_field_defs WHERE id = $1 AND org_id = $2 RETURNING key", [req.params.id, req.params.orgId]);
    if (!r.length) throw new HttpError(404, "Field not found");
    await audit(db, { orgId: req.params.orgId, actorId: user.id, action: "custom_field.delete", entityType: "custom_field", entityId: req.params.id });
    return { ok: true };
  });

  async function entityAccess(type: CfEntity, id: string, userId: string, write: boolean) {
    if (type === "project") {
      const access = await requireProject(db, userId, id, write ? "record.manage" : "read");
      return access.project.org_id;
    }
    const { access } = await loadInProject(db, ENTITY_TABLE[type], id, userId, write ? "record.write" : "read.full");
    return access.project.org_id;
  }

  app.get<{ Params: { entityType: string; entityId: string } }>("/custom-values/:entityType/:entityId", async (req) => {
    const user = requireUser(req);
    const type = z.enum(Object.keys(ENTITY_TABLE) as [CfEntity]).parse(req.params.entityType);
    const orgId = await entityAccess(type, req.params.entityId, user.id, false);
    return db.query(
      `SELECT d.id, d.key, d.label, d.type, d.options, d.required, v.value FROM custom_field_defs d
         LEFT JOIN custom_field_values v ON v.field_id = d.id AND v.entity_id = $3
        WHERE d.org_id = $1 AND d.entity_type = $2 ORDER BY d.created_at`,
      [orgId, type, req.params.entityId],
    );
  });

  app.put<{ Params: { entityType: string; entityId: string } }>("/custom-values/:entityType/:entityId", async (req) => {
    const user = requireUser(req);
    const type = z.enum(Object.keys(ENTITY_TABLE) as [CfEntity]).parse(req.params.entityType);
    const orgId = await entityAccess(type, req.params.entityId, user.id, true);
    const b = z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).parse(req.body);
    const defs = await db.query<{ id: string; key: string; label: string; type: string; options: string[]; required: boolean }>(
      "SELECT id, key, label, type, options, required FROM custom_field_defs WHERE org_id = $1 AND entity_type = $2",
      [orgId, type],
    );
    const byKey = new Map(defs.map((d) => [d.key, d]));
    for (const k of Object.keys(b.values)) if (!byKey.has(k)) throw new HttpError(400, `Unknown field: ${k}`);
    return db.tx(async (q) => {
      for (const [k, raw] of Object.entries(b.values)) {
        const d = byKey.get(k)!;
        const v = raw === null || raw === "" ? null : String(raw);
        if (v === null) {
          if (d.required) throw new HttpError(400, `${d.label} is required`);
          await q.query("DELETE FROM custom_field_values WHERE field_id = $1 AND entity_id = $2", [d.id, req.params.entityId]);
          continue;
        }
        if (d.type === "number" && !/^-?\d+(\.\d+)?$/.test(v)) throw new HttpError(400, `${d.label} must be a number`);
        if (d.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${d.label} must be a date (YYYY-MM-DD)`);
        if (d.type === "boolean" && !["true", "false"].includes(v)) throw new HttpError(400, `${d.label} must be true or false`);
        if (d.type === "select" && !d.options.includes(v)) throw new HttpError(400, `${d.label} must be one of: ${d.options.join(", ")}`);
        if (v.length > 2000) throw new HttpError(400, `${d.label} is too long`);
        await q.query(
          `INSERT INTO custom_field_values (field_id, entity_id, value) VALUES ($1, $2, $3) ON CONFLICT (field_id, entity_id) DO UPDATE SET value = EXCLUDED.value`,
          [d.id, req.params.entityId, v],
        );
      }
      await audit(q, { orgId, actorId: user.id, action: "custom_values.update", entityType: type, entityId: req.params.entityId, detail: b.values });
      return { ok: true };
    });
  });

  // ---------- Import / export ----------

  const EXPORTS: Record<string, { sql: string; headers: string[] }> = {
    rfis: {
      sql: `SELECT r.number, r.subject, r.status, a.name, r.due_date::text, r.cost_impact, r.schedule_impact, r.created_at::text,
                   (SELECT body FROM rfi_responses x WHERE x.rfi_id = r.id AND x.is_official LIMIT 1)
              FROM rfis r LEFT JOIN users a ON a.id = r.assignee_id WHERE r.project_id = $1 ORDER BY r.number`,
      headers: ["Number", "Subject", "Status", "Ball in court", "Due", "Cost impact", "Schedule impact", "Created", "Official answer"],
    },
    submittals: {
      sql: `SELECT s.number, s.revision, s.title, s.type, s.status, sp.number, s.due_date::text FROM submittals s LEFT JOIN spec_sections sp ON sp.id = s.spec_section_id WHERE s.project_id = $1 ORDER BY s.number, s.revision`,
      headers: ["Number", "Revision", "Title", "Type", "Status", "Spec section", "Due"],
    },
    "punch-items": {
      sql: `SELECT p.number, p.title, p.location, p.trade, p.status, a.name, p.due_date::text, p.closed_at::text FROM punch_items p LEFT JOIN users a ON a.id = p.assignee_id WHERE p.project_id = $1 ORDER BY p.number`,
      headers: ["Number", "Title", "Location", "Trade", "Status", "Assignee", "Due", "Closed"],
    },
    tasks: {
      sql: `SELECT t.title, t.status, a.name, t.due_date::text FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id WHERE t.project_id = $1 ORDER BY t.created_at`,
      headers: ["Title", "Status", "Assignee", "Due"],
    },
    observations: {
      sql: `SELECT o.type, o.severity, o.title, o.location, o.status, o.created_at::text, o.resolution FROM observations o WHERE o.project_id = $1 ORDER BY o.created_at`,
      headers: ["Type", "Severity", "Title", "Location", "Status", "Created", "Resolution"],
    },
    "daily-logs": {
      sql: `SELECT l.log_date::text, l.weather, l.temp_low::text, l.temp_high::text, coalesce((SELECT sum(workers) FROM daily_log_manpower m WHERE m.log_id = l.id), 0), l.work_performed, l.delays, l.status
              FROM daily_logs l WHERE l.project_id = $1 ORDER BY l.log_date`,
      headers: ["Date", "Weather", "Low", "High", "Workers", "Work performed", "Delays", "Status"],
    },
  };

  app.get<{ Params: { projectId: string; kind: string } }>("/projects/:projectId/export/:kind", async (req, reply) => {
    const user = requireUser(req);
    const kind = req.params.kind.replace(/\.csv$/, "");
    const def = EXPORTS[kind];
    if (!def) throw new HttpError(404, "Unknown export");
    const { project } = await requireProject(db, user.id, req.params.projectId, "read.full");
    const rows = await db.query<Record<string, unknown>>(def.sql, [project.id]);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${kind}.csv"`);
    return toCsv(def.headers, rows.map((r) => Object.values(r).map((v) => (v === null || v === undefined ? "" : String(v)))));
  });

  /** CSV import: punch-items (title,location,trade,due) or tasks (title,due). Header row required. */
  app.post<{ Params: { projectId: string; kind: string } }>("/projects/:projectId/import/:kind", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({ csv: z.string().min(1).max(1_000_000) }).parse(req.body);
    const rows = parseCsv(b.csv);
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (name: string) => header.indexOf(name);
    if (col("title") < 0) throw new HttpError(400, "The first row must be a header with a 'title' column");
    if (rows.length > 2000) throw new HttpError(400, "Import at most 2000 rows at a time");
    const due = (r: string[]) => {
      const v = col("due") >= 0 ? (r[col("due")] ?? "").trim() : "";
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Invalid due date "${v}" (use YYYY-MM-DD)`);
      return v || null;
    };
    const created = await db.tx(async (q) => {
      let n = 0;
      for (const r of rows) {
        const title = (r[col("title")] ?? "").trim();
        if (!title) continue;
        if (title.length > 300) throw new HttpError(400, `Title too long: ${title.slice(0, 40)}…`);
        if (req.params.kind === "punch-items") {
          const number = await nextNumber(q, "punch_items", project.id);
          await q.query(
            `INSERT INTO punch_items (project_id, number, title, location, trade, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [project.id, number, title, col("location") >= 0 ? r[col("location")]?.trim() || null : null, col("trade") >= 0 ? r[col("trade")]?.trim() || null : null, due(r), user.id],
          );
        } else if (req.params.kind === "tasks") {
          await q.query(`INSERT INTO tasks (project_id, title, due_date, created_by) VALUES ($1, $2, $3, $4)`, [project.id, title, due(r), user.id]);
        } else {
          throw new HttpError(404, "Unknown import");
        }
        n++;
      }
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: `import.${req.params.kind}`, entityType: "project", entityId: project.id, detail: { rows: n } });
      return n;
    });
    return reply.code(201).send({ created });
  });
};

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}
