import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireOrgRole, requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, nextNumber, toSet } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

/** Offline clients send a stable `clientId`; replays of the same create return the original row (200) instead of a duplicate. */
const clientId = z.uuid().optional();
type ClientTable = "daily_logs" | "inspections" | "punch_items" | "observations" | "incidents";
/** Runs `create` in a transaction unless a row with this clientId already exists; replies 201 (new) or 200 (replay) after commit. */
async function createOnce<T extends object>(
  db: AppConfig["db"], reply: FastifyReply, table: ClientTable, projectId: string, id: string | undefined, create: (q: Queryable) => Promise<T>,
) {
  const out = await db.tx(async (q) => {
    if (id) {
      const [prev] = await q.query<T>(`SELECT * FROM ${table} WHERE project_id = $1 AND client_id = $2`, [projectId, id]);
      if (prev) return { row: prev, replayed: true };
    }
    return { row: await create(q), replayed: false };
  });
  return reply.code(out.replayed ? 200 : 201).send({ ...out.row, replayed: out.replayed });
}

const optText = (max: number) => z.string().trim().max(max).nullable().optional();

const manpower = z.array(z.object({
  company: z.string().trim().min(1).max(200),
  trade: optText(100),
  workers: z.number().int().min(0).max(10000),
  hours: z.union([z.number(), z.string()]).transform(String).pipe(z.string().regex(/^\d{1,6}(\.\d{1,2})?$/, "Hours must be a number with up to 2 decimals")).default("0"),
  notes: optText(1000),
})).max(100);

const dailyLogInput = z.object({
  logDate: z.iso.date(),
  weather: optText(200),
  tempLow: z.number().min(-100).max(150).nullable().optional(),
  tempHigh: z.number().min(-100).max(150).nullable().optional(),
  workPerformed: optText(20000),
  delays: optText(5000),
  visitors: optText(5000),
  notes: optText(20000),
  manpower: manpower.optional(),
  clientId,
});
const LOG_COLS = { weather: "weather", tempLow: "temp_low", tempHigh: "temp_high", workPerformed: "work_performed", delays: "delays", visitors: "visitors", notes: "notes" };

const punchInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: optText(10000),
  location: optText(200),
  trade: optText(100),
  assigneeId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  clientId,
});

export const fieldRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  // ---------- Daily logs ----------

  app.get<P & { Querystring: { from?: string; to?: string } }>("/projects/:projectId/daily-logs", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    const date = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return db.query(
      `SELECT l.id, l.log_date, l.weather, l.status, l.temp_low, l.temp_high,
              coalesce((SELECT sum(m.workers) FROM daily_log_manpower m WHERE m.log_id = l.id), 0)::int AS workers,
              coalesce((SELECT sum(m.hours) FROM daily_log_manpower m WHERE m.log_id = l.id), 0)::numeric(12,2)::text AS hours,
              u.name AS created_by_name
         FROM daily_logs l LEFT JOIN users u ON u.id = l.created_by
        WHERE l.project_id = $1 AND ($2::date IS NULL OR l.log_date >= $2) AND ($3::date IS NULL OR l.log_date <= $3)
        ORDER BY l.log_date DESC LIMIT 400`,
      [req.params.projectId, date(req.query.from), date(req.query.to)],
    );
  });

  app.post<P>("/projects/:projectId/daily-logs", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = dailyLogInput.parse(req.body);
    return createOnce(db, reply, "daily_logs", project.id, b.clientId, async (q) => {
      if ((await q.query("SELECT 1 FROM daily_logs WHERE project_id = $1 AND log_date = $2", [project.id, b.logDate])).length) {
        throw new HttpError(409, `A daily log for ${b.logDate} already exists`);
      }
      const [log] = await q.query<{ id: string }>(
        `INSERT INTO daily_logs (project_id, log_date, weather, temp_low, temp_high, work_performed, delays, visitors, notes, client_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [project.id, b.logDate, b.weather ?? null, b.tempLow ?? null, b.tempHigh ?? null, b.workPerformed ?? null, b.delays ?? null, b.visitors ?? null, b.notes ?? null, b.clientId ?? null, user.id],
      );
      await writeManpower(q, log!.id, b.manpower ?? []);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "daily_log.create", entityType: "daily_log", entityId: log!.id, detail: { date: b.logDate } });
      return log!;
    });
  });

  async function writeManpower(q: Queryable, logId: string, rows: z.infer<typeof manpower>) {
    await q.query("DELETE FROM daily_log_manpower WHERE log_id = $1", [logId]);
    for (const m of rows) {
      await q.query(`INSERT INTO daily_log_manpower (log_id, company, trade, workers, hours, notes) VALUES ($1, $2, $3, $4, $5, $6)`, [logId, m.company, m.trade ?? null, m.workers, m.hours, m.notes ?? null]);
    }
  }

  app.get<Id>("/daily-logs/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "daily_logs", req.params.id, user.id, "read", "Daily log");
    const [detail] = await db.query(
      `SELECT l.*, c.name AS created_by_name, s.name AS signed_by_name FROM daily_logs l
         LEFT JOIN users c ON c.id = l.created_by LEFT JOIN users s ON s.id = l.signed_by WHERE l.id = $1`,
      [row.id],
    );
    const manpowerRows = await db.query("SELECT id, company, trade, workers, hours::text, notes FROM daily_log_manpower WHERE log_id = $1 ORDER BY company", [row.id]);
    const photos = await attachmentsOf("daily_log", row.id);
    return { ...detail, manpower: manpowerRows, photos, myRole: access.role };
  });

  app.patch<Id>("/daily-logs/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "daily_logs", req.params.id, user.id, "record.write", "Daily log");
    if (row.status === "signed") throw new HttpError(409, "A signed daily log cannot be changed");
    const b = dailyLogInput.omit({ logDate: true, clientId: true }).partial().parse(req.body);
    const { sets, values } = toSet(b, LOG_COLS);
    return db.tx(async (q) => {
      if (sets.length) await q.query(`UPDATE daily_logs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, [row.id, ...values]);
      if (b.manpower) await writeManpower(q, row.id, b.manpower);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "daily_log.update", entityType: "daily_log", entityId: row.id });
      return { ok: true };
    });
  });

  /** Signing locks the log (a manager's sign-off). */
  app.post<Id>("/daily-logs/:id/sign", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; log_date: string }>(db, "daily_logs", req.params.id, user.id, "record.manage", "Daily log");
    if (row.status === "signed") throw new HttpError(409, "Already signed");
    return db.tx(async (q) => {
      await q.query("UPDATE daily_logs SET status = 'signed', signed_by = $2, signed_at = now(), updated_at = now() WHERE id = $1", [row.id, user.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "daily_log.sign", entityType: "daily_log", entityId: row.id });
      return { ok: true };
    });
  });

  // ---------- Inspection templates (org level) ----------

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/inspection-templates", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin", "member"]);
    return db.query("SELECT id, name, items FROM inspection_templates WHERE org_id = $1 ORDER BY name", [req.params.orgId]);
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/inspection-templates", async (req, reply) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId)) throw new HttpError(404, "Organization not found");
    await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const b = z.object({ name: z.string().trim().min(1).max(200), items: z.array(z.string().trim().min(1).max(500)).min(1).max(200) }).parse(req.body);
    const [t] = await db.query(`INSERT INTO inspection_templates (org_id, name, items) VALUES ($1, $2, $3) RETURNING *`, [req.params.orgId, b.name, JSON.stringify(b.items)]);
    await audit(db, { orgId: req.params.orgId, actorId: user.id, action: "inspection_template.create", entityType: "inspection_template", entityId: (t as { id: string }).id, detail: { name: b.name } });
    return reply.code(201).send(t);
  });

  // ---------- Inspections ----------

  app.get<P>("/projects/:projectId/inspections", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT i.id, i.title, i.location, i.status, i.created_at, i.completed_at, u.name AS inspector_name,
              count(it.*) FILTER (WHERE it.result = 'fail')::int AS failed,
              count(it.*) FILTER (WHERE it.result IS NULL)::int AS unanswered,
              count(it.*)::int AS total
         FROM inspections i LEFT JOIN users u ON u.id = i.inspector_id LEFT JOIN inspection_items it ON it.inspection_id = i.id
        WHERE i.project_id = $1 GROUP BY i.id, u.name ORDER BY i.created_at DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/inspections", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({
      title: z.string().trim().min(1).max(300),
      location: optText(200),
      templateId: z.uuid().nullable().optional(),
      items: z.array(z.string().trim().min(1).max(500)).max(200).optional(),
      inspectorId: z.uuid().nullable().optional(),
      clientId,
    }).parse(req.body);
    return createOnce(db, reply, "inspections", project.id, b.clientId, async (q) => {
      let items = b.items ?? [];
      if (b.templateId) {
        const [t] = await q.query<{ items: string[] }>("SELECT items FROM inspection_templates WHERE id = $1 AND org_id = $2", [b.templateId, project.org_id]);
        if (!t) throw new HttpError(400, "Template not found");
        items = [...t.items, ...items];
      }
      if (!items.length) throw new HttpError(400, "An inspection needs at least one item");
      if (b.inspectorId) await assertProjectMember(q, project.id, b.inspectorId, "Inspector");
      const [ins] = await q.query<{ id: string }>(
        `INSERT INTO inspections (project_id, title, template_id, location, inspector_id, client_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [project.id, b.title, b.templateId ?? null, b.location ?? null, b.inspectorId ?? user.id, b.clientId ?? null, user.id],
      );
      for (const [i, text] of items.entries()) {
        await q.query("INSERT INTO inspection_items (inspection_id, seq, text) VALUES ($1, $2, $3)", [ins!.id, i + 1, text]);
      }
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "inspection.create", entityType: "inspection", entityId: ins!.id, detail: { title: b.title, items: items.length } });
      return ins!;
    });
  });

  app.get<Id>("/inspections/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "inspections", req.params.id, user.id, "read", "Inspection");
    const [detail] = await db.query(`SELECT i.*, u.name AS inspector_name FROM inspections i LEFT JOIN users u ON u.id = i.inspector_id WHERE i.id = $1`, [row.id]);
    const items = await db.query(
      `SELECT it.id, it.seq, it.text, it.result, it.note, it.punch_item_id, p.number AS punch_number, p.status AS punch_status
         FROM inspection_items it LEFT JOIN punch_items p ON p.id = it.punch_item_id WHERE it.inspection_id = $1 ORDER BY it.seq`,
      [row.id],
    );
    return { ...detail, items, photos: await attachmentsOf("inspection", row.id), myRole: access.role };
  });

  /** Record a result for one checklist item. `createPunch` on a failed item opens a linked punch item. */
  app.patch<{ Params: { id: string; itemId: string } }>("/inspections/:id/items/:itemId", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; title: string; location: string | null }>(db, "inspections", req.params.id, user.id, "record.write", "Inspection");
    if (row.status === "completed") throw new HttpError(409, "This inspection is completed");
    const b = z.object({
      result: z.enum(["pass", "fail", "na"]).nullable().optional(),
      note: optText(2000),
      createPunch: z.object({ assigneeId: z.uuid().nullable().optional(), dueDate: z.iso.date().nullable().optional() }).optional(),
    }).parse(req.body);
    if (!isUuid(req.params.itemId)) throw new HttpError(404, "Item not found");
    return db.tx(async (q) => {
      const [item] = await q.query<{ id: string; text: string; result: string | null; punch_item_id: string | null }>(
        "SELECT * FROM inspection_items WHERE id = $1 AND inspection_id = $2 FOR UPDATE", [req.params.itemId, row.id],
      );
      if (!item) throw new HttpError(404, "Item not found");
      const { sets, values } = toSet(b, { result: "result", note: "note" });
      if (sets.length) await q.query(`UPDATE inspection_items SET ${sets.join(", ")} WHERE id = $1`, [item.id, ...values]);
      let punchId: string | null = null;
      if (b.createPunch) {
        const result = b.result !== undefined ? b.result : item.result;
        if (result !== "fail") throw new HttpError(400, "Only failed items can create punch items");
        if (item.punch_item_id) throw new HttpError(409, "This item already has a punch item");
        if (b.createPunch.assigneeId) await assertProjectMember(q, row.project_id, b.createPunch.assigneeId);
        const number = await nextNumber(q, "punch_items", row.project_id);
        const [p] = await q.query<{ id: string }>(
          `INSERT INTO punch_items (project_id, number, title, description, location, assignee_id, due_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [row.project_id, number, item.text, `From inspection "${row.title}"${b.note ? `: ${b.note}` : ""}`, row.location, b.createPunch.assigneeId ?? null, b.createPunch.dueDate ?? null, user.id],
        );
        punchId = p!.id;
        await q.query("UPDATE inspection_items SET punch_item_id = $2 WHERE id = $1", [item.id, punchId]);
        await config.notify(q, [b.createPunch.assigneeId], { kind: "punch", title: `Punch item #${number} assigned to you: ${item.text}`, link: `/punch/${punchId}`, projectId: row.project_id, actorId: user.id });
      }
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "inspection.item", entityType: "inspection", entityId: row.id, detail: { item: item.text, result: b.result, punchId } });
      return { ok: true, punchItemId: punchId };
    });
  });

  app.post<Id>("/inspections/:id/complete", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "inspections", req.params.id, user.id, "record.write", "Inspection");
    if (row.status === "completed") throw new HttpError(409, "Already completed");
    return db.tx(async (q) => {
      const [open] = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM inspection_items WHERE inspection_id = $1 AND result IS NULL", [row.id]);
      if (open!.n) throw new HttpError(400, `${open!.n} item(s) still need a result`);
      await q.query("UPDATE inspections SET status = 'completed', completed_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "inspection.complete", entityType: "inspection", entityId: row.id });
      return { ok: true };
    });
  });

  // ---------- Punch list ----------

  app.get<P & { Querystring: { status?: string; mine?: string } }>("/projects/:projectId/punch-items", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT p.id, p.number, p.title, p.location, p.trade, p.status, p.due_date, p.assignee_id, u.name AS assignee_name,
              (p.status <> 'closed' AND p.due_date < current_date) AS overdue,
              (SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'punch_item' AND a.entity_id = p.id) AS photo_count
         FROM punch_items p LEFT JOIN users u ON u.id = p.assignee_id
        WHERE p.project_id = $1 AND ($2::text IS NULL OR p.status = $2) AND ($3::uuid IS NULL OR p.assignee_id = $3)
        ORDER BY (p.status = 'closed'), p.number`,
      [req.params.projectId, req.query.status || null, req.query.mine === "1" ? user.id : null],
    );
  });

  app.post<P>("/projects/:projectId/punch-items", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = punchInput.parse(req.body);
    return createOnce(db, reply, "punch_items", project.id, b.clientId, async (q) => {
      if (b.assigneeId) await assertProjectMember(q, project.id, b.assigneeId);
      const number = await nextNumber(q, "punch_items", project.id);
      const [p] = await q.query<{ id: string }>(
        `INSERT INTO punch_items (project_id, number, title, description, location, trade, assignee_id, due_date, client_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [project.id, number, b.title, b.description ?? null, b.location ?? null, b.trade ?? null, b.assigneeId ?? null, b.dueDate ?? null, b.clientId ?? null, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "punch.create", entityType: "punch_item", entityId: p!.id, detail: { number, title: b.title } });
      await config.notify(q, [b.assigneeId], { kind: "punch", title: `Punch item #${number} assigned to you: ${b.title}`, link: `/punch/${p!.id}`, projectId: project.id, actorId: user.id });
      return p!;
    });
  });

  app.get<Id>("/punch-items/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "punch_items", req.params.id, user.id, "read", "Punch item");
    const [detail] = await db.query(
      `SELECT p.*, u.name AS assignee_name, c.name AS created_by_name,
              (SELECT json_build_object('id', i.id, 'title', i.title) FROM inspection_items it JOIN inspections i ON i.id = it.inspection_id WHERE it.punch_item_id = p.id LIMIT 1) AS inspection
         FROM punch_items p LEFT JOIN users u ON u.id = p.assignee_id LEFT JOIN users c ON c.id = p.created_by WHERE p.id = $1`,
      [row.id],
    );
    return { ...detail, photos: await attachmentsOf("punch_item", row.id), myRole: access.role, myId: user.id };
  });

  app.patch<Id>("/punch-items/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number; title: string; assignee_id: string | null }>(db, "punch_items", req.params.id, user.id, "record.write", "Punch item");
    if (row.status === "closed") throw new HttpError(409, "Reopen the item before editing it");
    const b = punchInput.omit({ clientId: true }).partial().parse(req.body);
    const { sets, values } = toSet(b, { title: "title", description: "description", location: "location", trade: "trade", assigneeId: "assignee_id", dueDate: "due_date" });
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    return db.tx(async (q) => {
      if (b.assigneeId) await assertProjectMember(q, row.project_id, b.assigneeId);
      const [r] = await q.query(`UPDATE punch_items SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, [row.id, ...values]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "punch.update", entityType: "punch_item", entityId: row.id, detail: b });
      if (b.assigneeId && b.assigneeId !== row.assignee_id) await config.notify(q, [b.assigneeId], { kind: "punch", title: `Punch item #${row.number} assigned to you: ${row.title}`, link: `/punch/${row.id}`, projectId: row.project_id, actorId: user.id });
      return r;
    });
  });

  /**
   * Workflow: assignee (any role) marks ready_for_review → creator or manager verifies (closed) or sends back (open).
   * Closing requires at least one photo as evidence when `requirePhotoToClose` is set on the request.
   */
  app.post<Id>("/punch-items/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number; title: string; assignee_id: string | null; created_by: string | null }>(db, "punch_items", req.params.id, user.id, "read", "Punch item");
    const b = z.object({ status: z.enum(["open", "ready_for_review", "closed"]), requirePhoto: z.boolean().optional() }).parse(req.body);
    const manager = access.role === "admin" || access.role === "manager";
    const verifier = manager || (row.created_by === user.id && access.role !== "viewer");
    if (b.status === "ready_for_review") {
      if (row.assignee_id !== user.id && !verifier) throw new HttpError(403, "Only the assignee can mark this ready for review");
      if (row.status !== "open") throw new HttpError(409, "Only open items can be marked ready");
    } else if (!verifier) {
      throw new HttpError(403, "Only the creator or a manager can close or reopen punch items");
    }
    if (b.status === "closed" && b.requirePhoto) {
      const [ph] = await db.query("SELECT 1 FROM attachments WHERE entity_type = 'punch_item' AND entity_id = $1", [row.id]);
      if (!ph) throw new HttpError(400, "Attach a photo before closing");
    }
    return db.tx(async (q) => {
      const [r] = await q.query(
        `UPDATE punch_items SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id, b.status],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `punch.${b.status}`, entityType: "punch_item", entityId: row.id, detail: { number: row.number } });
      const notifyWho = b.status === "ready_for_review" ? [row.created_by] : [row.assignee_id];
      await config.notify(q, notifyWho, { kind: "punch", title: `Punch item #${row.number} is ${b.status.replace(/_/g, " ")}`, link: `/punch/${row.id}`, projectId: row.project_id, actorId: user.id });
      return r;
    });
  });

  // ---------- Observations ----------

  const observationInput = z.object({
    type: z.enum(["safety", "quality", "environmental", "housekeeping"]),
    severity: z.enum(["low", "medium", "high"]).default("medium"),
    title: z.string().trim().min(1).max(300),
    description: optText(10000),
    location: optText(200),
    assigneeId: z.uuid().nullable().optional(),
    dueDate: z.iso.date().nullable().optional(),
    clientId,
  });

  app.get<P>("/projects/:projectId/observations", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT o.id, o.type, o.severity, o.title, o.location, o.status, o.due_date, o.created_at, u.name AS assignee_name
         FROM observations o LEFT JOIN users u ON u.id = o.assignee_id WHERE o.project_id = $1 ORDER BY (o.status = 'closed'), o.created_at DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/observations", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = observationInput.parse(req.body);
    return createOnce(db, reply, "observations", project.id, b.clientId, async (q) => {
      if (b.assigneeId) await assertProjectMember(q, project.id, b.assigneeId);
      const [o] = await q.query<{ id: string }>(
        `INSERT INTO observations (project_id, type, severity, title, description, location, assignee_id, due_date, client_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [project.id, b.type, b.severity, b.title, b.description ?? null, b.location ?? null, b.assigneeId ?? null, b.dueDate ?? null, b.clientId ?? null, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "observation.create", entityType: "observation", entityId: o!.id, detail: { type: b.type, severity: b.severity, title: b.title } });
      await config.notify(q, [b.assigneeId], { kind: "observation", title: `${b.severity === "high" ? "HIGH severity " : ""}${b.type} observation: ${b.title}`, link: `/observations/${o!.id}`, projectId: project.id, actorId: user.id });
      return o!;
    });
  });

  app.get<Id>("/observations/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "observations", req.params.id, user.id, "read", "Observation");
    const [detail] = await db.query(`SELECT o.*, u.name AS assignee_name, c.name AS created_by_name FROM observations o LEFT JOIN users u ON u.id = o.assignee_id LEFT JOIN users c ON c.id = o.created_by WHERE o.id = $1`, [row.id]);
    return { ...detail, photos: await attachmentsOf("observation", row.id), myRole: access.role };
  });

  app.post<Id>("/observations/:id/close", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; assignee_id: string | null }>(db, "observations", req.params.id, user.id, "read", "Observation");
    if (access.role === "viewer" && row.assignee_id !== user.id) throw new HttpError(403, "You do not have permission to do that");
    if (row.status === "closed") throw new HttpError(409, "Already closed");
    const b = z.object({ resolution: z.string().trim().min(1).max(5000) }).parse(req.body);
    return db.tx(async (q) => {
      await q.query("UPDATE observations SET status = 'closed', resolution = $2, closed_at = now() WHERE id = $1", [row.id, b.resolution]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "observation.close", entityType: "observation", entityId: row.id, detail: b });
      return { ok: true };
    });
  });

  // ---------- Incidents ----------

  const incidentInput = z.object({
    occurredAt: z.iso.datetime({ offset: true }),
    type: z.enum(["injury", "near_miss", "property_damage", "environmental"]),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(20000),
    location: optText(200),
    injuredParty: optText(200),
    oshaRecordable: z.boolean().default(false),
    lostTime: z.boolean().default(false),
    clientId,
  });

  app.get<P>("/projects/:projectId/incidents", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT id, occurred_at, type, title, status, osha_recordable, lost_time FROM incidents WHERE project_id = $1 ORDER BY occurred_at DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/incidents", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = incidentInput.parse(req.body);
    if (new Date(b.occurredAt).getTime() > Date.now() + 5 * 60_000) throw new HttpError(400, "An incident cannot be in the future");
    return createOnce(db, reply, "incidents", project.id, b.clientId, async (q) => {
      const [i] = await q.query<{ id: string }>(
        `INSERT INTO incidents (project_id, occurred_at, type, title, description, location, injured_party, osha_recordable, lost_time, client_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [project.id, b.occurredAt, b.type, b.title, b.description, b.location ?? null, b.injuredParty ?? null, b.oshaRecordable, b.lostTime, b.clientId ?? null, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "incident.create", entityType: "incident", entityId: i!.id, detail: { type: b.type, title: b.title, oshaRecordable: b.oshaRecordable } });
      // Every project manager hears about incidents immediately.
      const managers = await q.query<{ user_id: string }>(
        `SELECT pm.user_id FROM project_memberships pm WHERE pm.project_id = $1 AND pm.role = 'manager'
         UNION SELECT om.user_id FROM org_memberships om WHERE om.org_id = $2 AND om.role IN ('owner','admin')`,
        [project.id, project.org_id],
      );
      await config.notify(q, managers.map((m) => m.user_id), { kind: "incident", title: `Incident reported: ${b.title}`, link: `/incidents/${i!.id}`, projectId: project.id, actorId: user.id });
      return i!;
    });
  });

  app.get<Id>("/incidents/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "incidents", req.params.id, user.id, "read", "Incident");
    const [detail] = await db.query(`SELECT i.*, c.name AS created_by_name FROM incidents i LEFT JOIN users c ON c.id = i.created_by WHERE i.id = $1`, [row.id]);
    return { ...detail, photos: await attachmentsOf("incident", row.id), myRole: access.role };
  });

  app.patch<Id>("/incidents/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "incidents", req.params.id, user.id, "record.manage", "Incident");
    const b = z.object({
      status: z.enum(["open", "investigating", "closed"]).optional(),
      rootCause: optText(10000),
      correctiveAction: optText(10000),
      oshaRecordable: z.boolean().optional(),
      lostTime: z.boolean().optional(),
    }).parse(req.body);
    if (b.status === "closed" && !(b.correctiveAction ?? (row as unknown as { corrective_action: string | null }).corrective_action)) {
      throw new HttpError(400, "Record the corrective action before closing");
    }
    const { sets, values } = toSet(b, { status: "status", rootCause: "root_cause", correctiveAction: "corrective_action", oshaRecordable: "osha_recordable", lostTime: "lost_time" });
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    if (b.status) sets.push(`closed_at = ${b.status === "closed" ? "now()" : "NULL"}`);
    return db.tx(async (q) => {
      const [r] = await q.query(`UPDATE incidents SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, [row.id, ...values]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "incident.update", entityType: "incident", entityId: row.id, detail: b });
      return r;
    });
  });

  async function attachmentsOf(type: string, id: string) {
    return db.query(
      `SELECT f.id, f.name, f.mime, f.size, f.created_at FROM attachments a JOIN files f ON f.id = a.file_id
        WHERE a.entity_type = $1 AND a.entity_id = $2 ORDER BY a.created_at`,
      [type, id],
    );
  }
};
