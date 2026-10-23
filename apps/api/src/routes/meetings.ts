import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { fmt, sum } from "../lib/money.js";
import { requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, editable } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const itemInput = z.object({
  topic: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(10000).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  status: z.enum(["open", "closed"]).default("open"),
});

export const meetingRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  // ---------- Meetings ----------

  app.get<P>("/projects/:projectId/meetings", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT m.id, m.title, m.starts_at, m.location, m.status,
              (SELECT count(*)::int FROM meeting_items i WHERE i.meeting_id = m.id AND i.status = 'open' AND i.assignee_id IS NOT NULL) AS open_actions
         FROM meetings m WHERE m.project_id = $1 ORDER BY m.starts_at DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/meetings", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({
      title: z.string().trim().min(1).max(300),
      startsAt: z.iso.datetime({ offset: true }),
      location: z.string().trim().max(300).nullable().optional(),
      attendeeIds: z.array(z.uuid()).max(100).default([]),
      agenda: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
    }).parse(req.body);
    const m = await db.tx(async (q) => {
      for (const a of b.attendeeIds) await assertProjectMember(q, project.id, a, "Attendee");
      const [row] = await q.query<{ id: string }>(
        `INSERT INTO meetings (project_id, title, starts_at, location, attendee_ids, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [project.id, b.title, b.startsAt, b.location ?? null, b.attendeeIds, user.id],
      );
      for (const [i, topic] of b.agenda.entries()) await q.query("INSERT INTO meeting_items (meeting_id, seq, topic) VALUES ($1, $2, $3)", [row!.id, i + 1, topic]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "meeting.create", entityType: "meeting", entityId: row!.id, detail: { title: b.title } });
      await config.notify(q, b.attendeeIds, { kind: "meeting", title: `Meeting: ${b.title}`, link: `/meetings/${row!.id}`, projectId: project.id, actorId: user.id });
      return row!;
    });
    return reply.code(201).send(m);
  });

  app.get<Id>("/meetings/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; attendee_ids: string[] }>(db, "meetings", req.params.id, user.id, "read.full", "Meeting");
    const items = await db.query(
      `SELECT i.id, i.seq, i.topic, i.notes, i.assignee_id, i.due_date, i.status, u.name AS assignee_name
         FROM meeting_items i LEFT JOIN users u ON u.id = i.assignee_id WHERE i.meeting_id = $1 ORDER BY i.seq`,
      [row.id],
    );
    const attendees = await db.query("SELECT id, name FROM users WHERE id = ANY($1::uuid[]) ORDER BY name", [row.attendee_ids]);
    return { ...row, items, attendees, myRole: access.role };
  });

  app.post<Id>("/meetings/:id/items", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "meetings", req.params.id, user.id, "record.write", "Meeting");
    if (row.status === "minutes_published") throw new HttpError(409, "Minutes are published");
    const b = itemInput.parse(req.body);
    const item = await db.tx(async (q) => {
      if (b.assigneeId) await assertProjectMember(q, row.project_id, b.assigneeId);
      const [n] = await q.query<{ n: number }>("SELECT coalesce(max(seq), 0)::int + 1 AS n FROM meeting_items WHERE meeting_id = $1", [row.id]);
      const [i] = await q.query(
        `INSERT INTO meeting_items (meeting_id, seq, topic, notes, assignee_id, due_date, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [row.id, n!.n, b.topic, b.notes ?? null, b.assigneeId ?? null, b.dueDate ?? null, b.status],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "meeting.item", entityType: "meeting", entityId: row.id, detail: { topic: b.topic } });
      return i;
    });
    return reply.code(201).send(item);
  });

  app.patch<{ Params: { id: string; itemId: string } }>("/meetings/:id/items/:itemId", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string }>(db, "meetings", req.params.id, user.id, "record.write", "Meeting");
    const b = editable(itemInput).parse(req.body);
    return db.tx(async (q) => {
      if (b.assigneeId) await assertProjectMember(q, row.project_id, b.assigneeId);
      const [i] = await q.query(
        `UPDATE meeting_items SET topic = coalesce($3, topic), notes = CASE WHEN $4 THEN $5 ELSE notes END,
                assignee_id = CASE WHEN $6 THEN $7::uuid ELSE assignee_id END, due_date = CASE WHEN $8 THEN $9::date ELSE due_date END,
                status = coalesce($10, status)
          WHERE id = $2 AND meeting_id = $1 RETURNING *`,
        [row.id, req.params.itemId, b.topic ?? null, b.notes !== undefined, b.notes ?? null, b.assigneeId !== undefined, b.assigneeId ?? null, b.dueDate !== undefined, b.dueDate ?? null, b.status ?? null],
      );
      if (!i) throw new HttpError(404, "Item not found");
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "meeting.item_update", entityType: "meeting", entityId: row.id, detail: b });
      return i;
    });
  });

  /** Publishing locks the minutes and notifies attendees and everyone with an action item. */
  app.post<Id>("/meetings/:id/publish", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string; title: string; attendee_ids: string[] }>(db, "meetings", req.params.id, user.id, "record.write", "Meeting");
    if (row.status === "minutes_published") throw new HttpError(409, "Already published");
    return db.tx(async (q) => {
      await q.query("UPDATE meetings SET status = 'minutes_published', published_at = now() WHERE id = $1", [row.id]);
      const owners = await q.query<{ assignee_id: string }>("SELECT DISTINCT assignee_id FROM meeting_items WHERE meeting_id = $1 AND assignee_id IS NOT NULL", [row.id]);
      await config.notify(q, [...row.attendee_ids, ...owners.map((o) => o.assignee_id)], { kind: "meeting", title: `Minutes published: ${row.title}`, link: `/meetings/${row.id}`, projectId: row.project_id, actorId: user.id });
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "meeting.publish", entityType: "meeting", entityId: row.id });
      return { ok: true };
    });
  });

  // ---------- Timesheets ----------

  app.get<P & { Querystring: { from?: string; to?: string } }>("/projects/:projectId/timesheets", async (req) => {
    const user = requireUser(req);
    const access = await requireProject(db, user.id, req.params.projectId, "read");
    const manager = access.role === "admin" || access.role === "manager";
    const d = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const rows = await db.query<{ hours: string; status: string }>(
      `SELECT t.id, t.work_date, t.hours::text, t.description, t.status, t.user_id, u.name AS worker_name, c.code AS cost_code, d.name AS decided_by_name
         FROM timesheet_entries t JOIN users u ON u.id = t.user_id LEFT JOIN cost_codes c ON c.id = t.cost_code_id LEFT JOIN users d ON d.id = t.decided_by
        WHERE t.project_id = $1 AND ($2::uuid IS NULL OR t.user_id = $2) AND ($3::date IS NULL OR t.work_date >= $3) AND ($4::date IS NULL OR t.work_date <= $4)
        ORDER BY t.work_date DESC, u.name`,
      [req.params.projectId, manager ? null : user.id, d(req.query.from), d(req.query.to)],
    );
    const approved = fmt(sum(rows.filter((r) => r.status === "approved").map((r) => r.hours)));
    return { entries: rows, totals: { approvedHours: approved, allHours: fmt(sum(rows.map((r) => r.hours))) }, canApprove: manager };
  });

  /** Anyone on the project (including subcontractors) logs their own hours. */
  app.post<P>("/projects/:projectId/timesheets", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "read");
    const b = z.object({
      workDate: z.iso.date(),
      hours: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "Hours must be a number with up to 2 decimals")),
      costCodeId: z.uuid().nullable().optional(),
      description: z.string().trim().max(2000).nullable().optional(),
    }).parse(req.body);
    if (Number(b.hours) <= 0 || Number(b.hours) > 24) throw new HttpError(400, "Hours must be between 0 and 24");
    if (b.workDate > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) throw new HttpError(400, "Cannot log future time");
    const entry = await db.tx(async (q) => {
      if (b.costCodeId && !(await q.query("SELECT 1 FROM cost_codes WHERE id = $1 AND project_id = $2", [b.costCodeId, project.id])).length) throw new HttpError(400, "Unknown cost code");
      const [day] = await q.query<{ h: string | null }>("SELECT sum(hours)::text AS h FROM timesheet_entries WHERE project_id = $1 AND user_id = $2 AND work_date = $3 AND status <> 'rejected'", [project.id, user.id, b.workDate]);
      if (Number(day?.h ?? 0) + Number(b.hours) > 24) throw new HttpError(400, "More than 24 hours on one day");
      const [t] = await q.query<{ id: string }>(
        `INSERT INTO timesheet_entries (project_id, user_id, work_date, cost_code_id, hours, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [project.id, user.id, b.workDate, b.costCodeId ?? null, b.hours, b.description ?? null],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "timesheet.create", entityType: "timesheet_entry", entityId: t!.id, detail: { date: b.workDate, hours: b.hours } });
      return t;
    });
    return reply.code(201).send(entry);
  });

  app.post<Id>("/timesheets/:id/decide", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; user_id: string; status: string }>(db, "timesheet_entries", req.params.id, user.id, "record.manage", "Timesheet entry");
    const b = z.object({ decision: z.enum(["approved", "rejected"]) }).parse(req.body);
    if (row.user_id === user.id) throw new HttpError(403, "You cannot approve your own time");
    if (row.status !== "submitted") throw new HttpError(409, "Already decided");
    return db.tx(async (q) => {
      await q.query("UPDATE timesheet_entries SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [row.id, b.decision, user.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `timesheet.${b.decision}`, entityType: "timesheet_entry", entityId: row.id });
      await config.notify(q, [row.user_id], { kind: "timesheet", title: `Your time entry was ${b.decision}`, link: `/projects/${row.project_id}/timesheets`, projectId: row.project_id, actorId: user.id });
      return { ok: true };
    });
  });
};
