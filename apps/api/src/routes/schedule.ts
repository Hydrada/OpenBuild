import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, toSet } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const input = z.object({
  name: z.string().trim().min(1).max(300),
  startDate: z.iso.date(),
  endDate: z.iso.date().optional(),
  isMilestone: z.boolean().default(false),
  percentComplete: z.number().int().min(0).max(100).default(0),
  predecessorId: z.uuid().nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
});
const COLS = { name: "name", startDate: "start_date", endDate: "end_date", isMilestone: "is_milestone", percentComplete: "percent_complete", predecessorId: "predecessor_id", assigneeId: "assignee_id" };

export const scheduleRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  /** Schedule with derived flags: late (past finish, not complete) and dependency conflict (starts before predecessor finishes). */
  app.get<P>("/projects/:projectId/schedule", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT s.id, s.name, s.start_date, s.end_date, s.is_milestone, s.percent_complete, s.predecessor_id, s.assignee_id,
              u.name AS assignee_name, p.name AS predecessor_name,
              (s.percent_complete < 100 AND s.end_date < current_date) AS late,
              (p.id IS NOT NULL AND s.start_date <= p.end_date) AS dependency_conflict
         FROM schedule_items s LEFT JOIN users u ON u.id = s.assignee_id LEFT JOIN schedule_items p ON p.id = s.predecessor_id
        WHERE s.project_id = $1 ORDER BY s.start_date, s.end_date, s.name`,
      [req.params.projectId],
    );
  });

  async function validate(q: Queryable, projectId: string, selfId: string | null, b: { predecessorId?: string | null; assigneeId?: string | null }) {
    if (b.assigneeId) await assertProjectMember(q, projectId, b.assigneeId);
    if (b.predecessorId) {
      if (b.predecessorId === selfId) throw new HttpError(400, "An item cannot depend on itself");
      const [p] = await q.query("SELECT 1 FROM schedule_items WHERE id = $1 AND project_id = $2", [b.predecessorId, projectId]);
      if (!p) throw new HttpError(400, "Predecessor not found in this project");
      if (selfId) {
        // Walk the chain upward to refuse cycles.
        let cur: string | null = b.predecessorId;
        for (let i = 0; cur && i < 1000; i++) {
          if (cur === selfId) throw new HttpError(400, "That dependency would create a loop");
          const rows: { predecessor_id: string | null }[] = await q.query("SELECT predecessor_id FROM schedule_items WHERE id = $1", [cur]);
          cur = rows[0]?.predecessor_id ?? null;
        }
      }
    }
  }

  app.post<P>("/projects/:projectId/schedule", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = input.parse(req.body);
    const end = b.isMilestone ? b.startDate : b.endDate ?? b.startDate;
    if (end < b.startDate) throw new HttpError(400, "Finish is before start");
    const row = await db.tx(async (q) => {
      await validate(q, project.id, null, b);
      const [r] = await q.query<{ id: string }>(
        `INSERT INTO schedule_items (project_id, name, start_date, end_date, is_milestone, percent_complete, predecessor_id, assignee_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [project.id, b.name, b.startDate, end, b.isMilestone, b.percentComplete, b.predecessorId ?? null, b.assigneeId ?? null, user.id],
      );
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
      await validate(q, row.project_id, row.id, b);
      const [r] = await q.query(`UPDATE schedule_items SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, [row.id, ...values]);
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
};
