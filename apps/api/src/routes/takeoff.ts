import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireProject } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";
import { calibrate, measure, type Pt, type Scale } from "../lib/takeoff.js";

const unit = z.number().min(0).max(1);
const pt = z.tuple([unit, unit]);

/** Quantity takeoff on drawing sheets: calibrate the scale, then measure lengths, areas and counts. */
export const takeoffRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;
  type Id = { Params: { id: string } };

  async function revision(id: string, userId: string, action: "read.full" | "record.write") {
    if (!isUuid(id)) throw new HttpError(404, "Revision not found");
    const [rev] = await db.query<{ id: string; drawing_id: string }>("SELECT id, drawing_id FROM drawing_revisions WHERE id = $1", [id]);
    if (!rev) throw new HttpError(404, "Revision not found");
    const { row, access } = await loadInProject<{ project_id: string }>(db, "drawings", rev.drawing_id, userId, action, "Revision");
    return { rev, projectId: row.project_id, access };
  }

  app.get<Id>("/drawing-revisions/:id/takeoff", async (req) => {
    const user = requireUser(req);
    const { rev } = await revision(req.params.id, user.id, "read.full");
    const [scale] = await db.query("SELECT units_per_x, units_per_y, unit, set_at FROM takeoff_scales WHERE revision_id = $1", [rev.id]);
    const items = await db.query(
      `SELECT t.id, t.name, t.kind, t.points, t.quantity::text, t.unit, t.cost_code_id, c.code AS cost_code, u.name AS created_by_name
         FROM takeoff_items t LEFT JOIN cost_codes c ON c.id = t.cost_code_id LEFT JOIN users u ON u.id = t.created_by
        WHERE t.revision_id = $1 ORDER BY t.created_at`, [rev.id]);
    return { scale: scale ?? null, items };
  });

  /** `aspect` is the sheet's width / height in PDF units (the viewer knows it from the rendered page). */
  app.put<Id>("/drawing-revisions/:id/takeoff/scale", async (req) => {
    const user = requireUser(req);
    const { rev, projectId, access } = await revision(req.params.id, user.id, "record.write");
    const b = z.object({ a: pt, b: pt, distance: z.number().positive().max(1e6), unit: z.enum(["ft", "m"]), aspect: z.number().positive().max(20) }).parse(req.body);
    let s;
    try { s = calibrate(b.a as Pt, b.b as Pt, b.distance, b.aspect); } catch (e) { throw new HttpError(400, (e as Error).message); }
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO takeoff_scales (revision_id, project_id, units_per_x, units_per_y, unit, set_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (revision_id) DO UPDATE SET units_per_x = EXCLUDED.units_per_x, units_per_y = EXCLUDED.units_per_y, unit = EXCLUDED.unit, set_by = EXCLUDED.set_by, set_at = now()`,
        [rev.id, projectId, s.units_per_x, s.units_per_y, b.unit, user.id]);
      // Re-measure existing items so quantities always reflect the current scale.
      const items = await q.query<{ id: string; kind: "length" | "area" | "count"; points: Pt[] }>("SELECT id, kind, points FROM takeoff_items WHERE revision_id = $1", [rev.id]);
      for (const it of items) {
        const m = measure(it.kind, it.points, { ...s, unit: b.unit });
        await q.query("UPDATE takeoff_items SET quantity = $2, unit = $3 WHERE id = $1", [it.id, m.quantity, m.unit]);
      }
      await audit(q, { orgId: access.project.org_id, projectId, actorId: user.id, action: "takeoff.scale", entityType: "drawing", entityId: rev.drawing_id, detail: { distance: b.distance, unit: b.unit } });
    });
    return { ...s, unit: b.unit };
  });

  app.post<Id>("/drawing-revisions/:id/takeoff", async (req, reply) => {
    const user = requireUser(req);
    const { rev, projectId, access } = await revision(req.params.id, user.id, "record.write");
    const b = z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(["length", "area", "count"]), points: z.array(pt).min(1).max(2000), costCodeId: z.uuid().nullable().optional() }).parse(req.body);
    if (b.kind === "length" && b.points.length < 2) throw new HttpError(400, "A length needs at least two points");
    if (b.kind === "area" && b.points.length < 3) throw new HttpError(400, "An area needs at least three points");
    const [s] = await db.query<Scale>("SELECT units_per_x, units_per_y, unit FROM takeoff_scales WHERE revision_id = $1", [rev.id]);
    if (!s && b.kind !== "count") throw new HttpError(400, "Set the sheet's scale first");
    if (b.costCodeId && !(await db.query("SELECT 1 FROM cost_codes WHERE id = $1 AND project_id = $2", [b.costCodeId, projectId])).length) throw new HttpError(400, "Unknown cost code");
    const m = measure(b.kind, b.points as Pt[], s ?? { units_per_x: 1, units_per_y: 1, unit: "ft" });
    const [row] = await db.query<{ id: string }>(
      "INSERT INTO takeoff_items (project_id, revision_id, name, kind, points, quantity, unit, cost_code_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
      [projectId, rev.id, b.name, b.kind, JSON.stringify(b.points), m.quantity, m.unit, b.costCodeId ?? null, user.id]);
    await audit(db, { orgId: access.project.org_id, projectId, actorId: user.id, action: "takeoff.measure", entityType: "drawing", entityId: rev.drawing_id, detail: { name: b.name, ...m } });
    return reply.code(201).send({ id: row!.id, ...m });
  });

  app.delete<Id>("/takeoff-items/:id", async (req) => {
    const user = requireUser(req);
    const { row } = await loadInProject<{ id: string; project_id: string }>(db, "takeoff_items", req.params.id, user.id, "record.write", "Measurement");
    await db.query("DELETE FROM takeoff_items WHERE id = $1", [row.id]);
    return { ok: true };
  });

  /** Every measurement on the project, for pulling quantities into an estimate. */
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/takeoff", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT t.id, t.name, t.kind, t.quantity::text, t.unit, t.cost_code_id, c.code AS cost_code, d.number AS sheet, r.revision
         FROM takeoff_items t JOIN drawing_revisions r ON r.id = t.revision_id JOIN drawings d ON d.id = r.drawing_id LEFT JOIN cost_codes c ON c.id = t.cost_code_id
        WHERE t.project_id = $1 ORDER BY d.number, t.created_at`, [req.params.projectId]);
  });
};
