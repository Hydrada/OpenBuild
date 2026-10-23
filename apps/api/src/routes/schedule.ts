import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { assertAcyclic, criticalPath, type CpmLink, type WorkCalendar } from "../lib/cpm.js";
import { HttpError } from "../lib/errors.js";
import { parseMsProjectXml } from "../lib/msproject.js";
import { requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, toSet } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const link = z.object({ id: z.uuid(), lagDays: z.number().int().min(-3650).max(3650).default(0), type: z.enum(["FS", "SS", "FF", "SF"]).default("FS") });
const input = z.object({
  name: z.string().trim().min(1).max(300),
  startDate: z.iso.date(),
  endDate: z.iso.date().optional(),
  isMilestone: z.boolean().default(false),
  percentComplete: z.number().int().min(0).max(100).default(0),
  /** Finish-to-start predecessors. `predecessorId` is accepted for single-link clients. */
  predecessors: z.array(link).max(50).optional(),
  predecessorId: z.uuid().nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
});
const COLS = { name: "name", startDate: "start_date", endDate: "end_date", isMilestone: "is_milestone", percentComplete: "percent_complete", assigneeId: "assignee_id" };

function predecessorsOf(b: z.infer<typeof input> | Partial<z.infer<typeof input>>) {
  if (b.predecessors) return b.predecessors;
  if (b.predecessorId !== undefined) return b.predecessorId ? [{ id: b.predecessorId, lagDays: 0, type: "FS" as const }] : [];
  return undefined;
}

export const scheduleRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  async function linksFor(q: Queryable, projectId: string) {
    return q.query<CpmLink>(
      `SELECT l.successor_id, l.predecessor_id, l.lag_days, l.link_type FROM schedule_links l JOIN schedule_items s ON s.id = l.successor_id WHERE s.project_id = $1`,
      [projectId],
    );
  }

  async function calendarOf(q: Queryable, projectId: string): Promise<WorkCalendar> {
    const [p] = await q.query<{ work_days: number[] }>("SELECT work_days FROM projects WHERE id = $1", [projectId]);
    const holidays = await q.query<{ day: string }>("SELECT day FROM project_holidays WHERE project_id = $1", [projectId]);
    return { workDays: p!.work_days, holidays: holidays.map((h) => h.day) };
  }

  app.get<P>("/projects/:projectId/calendar", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const [p] = await db.query<{ work_days: number[] }>("SELECT work_days FROM projects WHERE id = $1", [req.params.projectId]);
    const holidays = await db.query("SELECT day, name FROM project_holidays WHERE project_id = $1 ORDER BY day", [req.params.projectId]);
    return { workDays: p!.work_days, holidays };
  });

  app.put<P>("/projects/:projectId/calendar", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = z.object({
      workDays: z.array(z.number().int().min(0).max(6)).min(1, "At least one working day").max(7),
      holidays: z.array(z.object({ day: z.iso.date(), name: z.string().trim().min(1).max(100) })).max(500).default([]),
    }).parse(req.body);
    return db.tx(async (q) => {
      await q.query("UPDATE projects SET work_days = $2 WHERE id = $1", [project.id, [...new Set(b.workDays)].sort()]);
      await q.query("DELETE FROM project_holidays WHERE project_id = $1", [project.id]);
      for (const h of b.holidays) await q.query("INSERT INTO project_holidays (project_id, day, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [project.id, h.day, h.name]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "schedule.calendar", entityType: "project", entityId: project.id, detail: { workDays: b.workDays, holidays: b.holidays.length } });
      return { ok: true };
    });
  });

  /** Schedule with late/conflict flags and critical-path dates and float. */
  app.get<P>("/projects/:projectId/schedule", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const rows = await db.query<{ id: string; start_date: string; end_date: string; percent_complete: number; name: string }>(
      `SELECT s.id, s.name, s.start_date, s.end_date, s.is_milestone, s.percent_complete, s.assignee_id, s.external_ref, u.name AS assignee_name
         FROM schedule_items s LEFT JOIN users u ON u.id = s.assignee_id
        WHERE s.project_id = $1 ORDER BY s.start_date, s.end_date, s.name`,
      [req.params.projectId],
    );
    if (!rows.length) return rows;
    const links = await linksFor(db, req.params.projectId);
    const cpm = criticalPath(rows, links, await calendarOf(db, req.params.projectId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const today = new Date().toISOString().slice(0, 10);
    return rows.map((r) => {
      const preds = links.filter((l) => l.successor_id === r.id).map((l) => ({ id: l.predecessor_id, name: byId.get(l.predecessor_id)!.name, lagDays: l.lag_days, type: l.link_type ?? "FS" }));
      // Planned dates that violate a link (the CPM early dates show where the activity can really start).
      const conflict = links.some((l) => {
        if (l.successor_id !== r.id) return false;
        const p = byId.get(l.predecessor_id)!;
        switch (l.link_type ?? "FS") {
          case "SS": return day(r.start_date) < day(p.start_date) + l.lag_days;
          case "FF": return day(r.end_date) < day(p.end_date) + l.lag_days;
          case "SF": return day(r.end_date) < day(p.start_date) + l.lag_days;
          default: return day(r.start_date) <= day(p.end_date) + l.lag_days;
        }
      });
      return {
        ...r, predecessors: preds,
        // Single-link fields kept for older clients.
        predecessor_id: preds[0]?.id ?? null, predecessor_name: preds.map((p) => p.name).join(", ") || null,
        late: r.percent_complete < 100 && r.end_date < today, dependency_conflict: conflict, ...cpm.get(r.id)!,
      };
    });
  });

  async function setLinks(q: Queryable, projectId: string, selfId: string, preds: { id: string; lagDays: number; type?: string }[]) {
    for (const p of preds) {
      if (p.id === selfId) throw new HttpError(400, "An item cannot depend on itself");
      if (!(await q.query("SELECT 1 FROM schedule_items WHERE id = $1 AND project_id = $2", [p.id, projectId])).length) throw new HttpError(400, "Predecessor not found in this project");
    }
    await q.query("DELETE FROM schedule_links WHERE successor_id = $1", [selfId]);
    for (const p of preds) await q.query("INSERT INTO schedule_links (successor_id, predecessor_id, lag_days, link_type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [selfId, p.id, p.lagDays, p.type ?? "FS"]);
    const ids = (await q.query<{ id: string }>("SELECT id FROM schedule_items WHERE project_id = $1", [projectId])).map((r) => r.id);
    try {
      assertAcyclic(ids, await linksFor(q, projectId));
    } catch {
      throw new HttpError(400, "That dependency would create a loop");
    }
  }

  app.post<P>("/projects/:projectId/schedule", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = input.parse(req.body);
    const end = b.isMilestone ? b.startDate : b.endDate ?? b.startDate;
    if (end < b.startDate) throw new HttpError(400, "Finish is before start");
    const row = await db.tx(async (q) => {
      if (b.assigneeId) await assertProjectMember(q, project.id, b.assigneeId);
      const [r] = await q.query<{ id: string }>(
        `INSERT INTO schedule_items (project_id, name, start_date, end_date, is_milestone, percent_complete, assignee_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [project.id, b.name, b.startDate, end, b.isMilestone, b.percentComplete, b.assigneeId ?? null, user.id],
      );
      await setLinks(q, project.id, r!.id, predecessorsOf(b) ?? []);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "schedule.create", entityType: "schedule_item", entityId: r!.id, detail: { name: b.name, milestone: b.isMilestone } });
      return r;
    });
    return reply.code(201).send(row);
  });

  app.patch<Id>("/schedule/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; start_date: string; end_date: string; is_milestone: boolean }>(db, "schedule_items", req.params.id, user.id, "record.write", "Schedule item");
    const b = input.partial().parse(req.body);
    const start = b.startDate ?? row.start_date;
    const milestone = b.isMilestone ?? row.is_milestone;
    const end = milestone ? start : b.endDate ?? row.end_date;
    if (end < start) throw new HttpError(400, "Finish is before start");
    const { sets, values } = toSet({ ...b, endDate: end }, COLS);
    return db.tx(async (q) => {
      if (b.assigneeId) await assertProjectMember(q, row.project_id, b.assigneeId);
      const [r] = await q.query(`UPDATE schedule_items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, [row.id, ...values]);
      const preds = predecessorsOf(b);
      if (preds) await setLinks(q, row.project_id, row.id, preds);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "schedule.update", entityType: "schedule_item", entityId: row.id, detail: b });
      return r;
    });
  });

  app.delete<Id>("/schedule/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; name: string }>(db, "schedule_items", req.params.id, user.id, "record.write", "Schedule item");
    return db.tx(async (q) => {
      await q.query("DELETE FROM schedule_items WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "schedule.delete", entityType: "schedule_item", entityId: row.id, detail: { name: row.name } });
      return { ok: true };
    });
  });

  /**
   * Import a Microsoft Project XML schedule (also produced by P6, ProjectLibre, GanttProject).
   * Re-importing the same file updates activities matched by their source UID instead of duplicating them.
   */
  app.post<P>("/projects/:projectId/schedule/import", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.manage");
    const b = z.object({ xml: z.string().min(1).max(20_000_000) }).parse(req.body);
    let tasks;
    try {
      tasks = parseMsProjectXml(b.xml);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (!tasks.length) throw new HttpError(400, "No activities found in the file");
    const result = await db.tx(async (q) => {
      const idByUid = new Map<string, string>();
      let created = 0, updated = 0;
      for (const t of tasks) {
        const ref = `msp:${t.uid}`;
        const [existing] = await q.query<{ id: string }>("SELECT id FROM schedule_items WHERE project_id = $1 AND external_ref = $2", [project.id, ref]);
        const end = t.milestone ? t.start : t.finish;
        if (existing) {
          await q.query("UPDATE schedule_items SET name = $2, start_date = $3, end_date = $4, is_milestone = $5, percent_complete = $6 WHERE id = $1", [existing.id, t.name, t.start, end, t.milestone, t.percent]);
          idByUid.set(t.uid, existing.id);
          updated++;
        } else {
          const [r] = await q.query<{ id: string }>(
            `INSERT INTO schedule_items (project_id, name, start_date, end_date, is_milestone, percent_complete, external_ref, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [project.id, t.name, t.start, end, t.milestone, t.percent, ref, user.id],
          );
          idByUid.set(t.uid, r!.id);
          created++;
        }
      }
      let links = 0;
      for (const t of tasks) {
        const preds = t.predecessors.filter((p) => idByUid.has(p.uid)).map((p) => ({ id: idByUid.get(p.uid)!, lagDays: p.lagDays, type: p.type }));
        await q.query("DELETE FROM schedule_links WHERE successor_id = $1", [idByUid.get(t.uid)]);
        for (const p of preds) await q.query("INSERT INTO schedule_links (successor_id, predecessor_id, lag_days, link_type) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [idByUid.get(t.uid), p.id, p.lagDays, p.type]);
        links += preds.length;
      }
      const ids = (await q.query<{ id: string }>("SELECT id FROM schedule_items WHERE project_id = $1", [project.id])).map((r) => r.id);
      try { assertAcyclic(ids, await linksFor(q, project.id)); } catch { throw new HttpError(400, "The imported schedule contains a dependency loop"); }
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "schedule.import", entityType: "project", entityId: project.id, detail: { created, updated, links } });
      return { created, updated, links };
    });
    return reply.code(201).send(result);
  });
};

const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
