import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { canWriteRecords, isUuid } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";

/** Coordinates are fractions of the sheet (0..1), so markups stay put at any zoom level. */
const unit = z.number().min(0).max(1);
const color = z.enum(["red", "blue", "green", "orange", "black"]);
const shape = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["rect", "cloud", "ellipse"]), x: unit, y: unit, w: unit, h: unit, color, label: z.string().trim().max(200).optional() }),
  z.object({ type: z.literal("arrow"), x1: unit, y1: unit, x2: unit, y2: unit, color }),
  z.object({ type: z.literal("text"), x: unit, y: unit, text: z.string().trim().min(1).max(500), color }),
  z.object({ type: z.literal("pen"), points: z.array(z.tuple([unit, unit])).min(2).max(2000), color }),
]);
export const shapes = z.array(shape).max(500);

/**
 * Personal markup layers on a drawing revision. Anyone who can see the sheet keeps a private layer; contributors and
 * above can publish theirs so the whole project sees it. Published layers are read-only to everyone but the author.
 */
export const annotationRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;
  type Id = { Params: { id: string } };

  async function revision(id: string, userId: string) {
    if (!isUuid(id)) throw new HttpError(404, "Revision not found");
    const [rev] = await db.query<{ id: string; drawing_id: string }>("SELECT id, drawing_id FROM drawing_revisions WHERE id = $1", [id]);
    if (!rev) throw new HttpError(404, "Revision not found");
    const { row, access } = await loadInProject<{ project_id: string; number: string }>(db, "drawings", rev.drawing_id, userId, "read", "Revision");
    return { rev, drawing: row, access };
  }

  app.get<Id>("/drawing-revisions/:id/annotations", async (req) => {
    const user = requireUser(req);
    const { rev, access } = await revision(req.params.id, user.id);
    const layers = await db.query<{ author_id: string; published_at: string | null }>(
      `SELECT a.id, a.author_id, u.name AS author_name, a.shapes, a.published_at, a.updated_at
         FROM drawing_annotations a JOIN users u ON u.id = a.author_id
        WHERE a.revision_id = $1 AND (a.published_at IS NOT NULL OR a.author_id = $2) ORDER BY a.published_at NULLS FIRST, u.name`,
      [rev.id, user.id],
    );
    return { mine: layers.find((l) => l.author_id === user.id) ?? null, published: layers.filter((l) => l.published_at && l.author_id !== user.id), canPublish: canWriteRecords(access.role) };
  });

  app.put<Id>("/drawing-revisions/:id/annotations", async (req) => {
    const user = requireUser(req);
    const { rev, drawing } = await revision(req.params.id, user.id);
    const b = z.object({ shapes }).parse(req.body);
    const [row] = await db.query<{ id: string; published_at: string | null }>(
      `INSERT INTO drawing_annotations (project_id, revision_id, author_id, shapes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (revision_id, author_id) DO UPDATE SET shapes = EXCLUDED.shapes, updated_at = now()
       RETURNING id, published_at`,
      [drawing.project_id, rev.id, user.id, JSON.stringify(b.shapes)],
    );
    return { id: row!.id, count: b.shapes.length, published: !!row!.published_at };
  });

  app.post<Id>("/drawing-revisions/:id/annotations/publish", async (req) => {
    const user = requireUser(req);
    const { rev, drawing, access } = await revision(req.params.id, user.id);
    if (!canWriteRecords(access.role)) throw new HttpError(403, "Only the project team can publish markups");
    const b = z.object({ published: z.boolean() }).parse(req.body);
    const done = await db.tx(async (q) => {
      const r = await q.query<{ id: string }>(
        `UPDATE drawing_annotations SET published_at = CASE WHEN $3 THEN coalesce(published_at, now()) END WHERE revision_id = $1 AND author_id = $2 RETURNING id`,
        [rev.id, user.id, b.published],
      );
      if (!r.length) throw new HttpError(400, "Save some markups first");
      await audit(q, { orgId: access.project.org_id, projectId: drawing.project_id, actorId: user.id, action: b.published ? "drawing.markup_publish" : "drawing.markup_unpublish", entityType: "drawing", entityId: rev.drawing_id, detail: { revision: rev.id } });
      return r[0]!;
    });
    return { id: done.id, published: b.published };
  });
};
