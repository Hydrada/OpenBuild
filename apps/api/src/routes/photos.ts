import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { exifTakenAt } from "../lib/exif.js";
import { HttpError } from "../lib/errors.js";
import { canWriteRecords, requireProject } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

/** Photo albums and metadata, and the structured sections of a daily log. */
export const photoRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db, storage } = config;

  // ---------- Photos ----------

  app.get<P>("/projects/:projectId/photo-albums", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT a.id, a.name, (SELECT count(*)::int FROM photo_meta m WHERE m.album_id = a.id) AS photos FROM photo_albums a WHERE a.project_id = $1 ORDER BY a.name`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/photo-albums", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({ name: z.string().trim().min(1).max(100) }).parse(req.body);
    if ((await db.query("SELECT 1 FROM photo_albums WHERE project_id = $1 AND lower(name) = lower($2)", [project.id, b.name])).length) throw new HttpError(409, "An album with that name already exists");
    const [a] = await db.query<{ id: string }>("INSERT INTO photo_albums (project_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name", [project.id, b.name, user.id]);
    return reply.code(201).send(a);
  });

  /** Photos with metadata. Capture time is read from EXIF the first time a photo is listed without it. */
  app.get<P & { Querystring: { album?: string; tag?: string; from?: string; to?: string } }>("/projects/:projectId/photos", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "read.full");
    const q = z.object({ album: z.union([z.uuid(), z.literal("none")]).optional(), tag: z.string().trim().max(50).optional(), from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(req.query);
    // Backfill metadata rows (and EXIF capture time) for images that have none yet.
    const missing = await db.query<{ id: string; storage_key: string; mime: string }>(
      "SELECT f.id, f.storage_key, f.mime FROM files f LEFT JOIN photo_meta m ON m.file_id = f.id WHERE f.project_id = $1 AND f.mime LIKE 'image/%' AND m.file_id IS NULL LIMIT 200", [project.id]);
    for (const f of missing) {
      let taken: string | null = null;
      if (f.mime === "image/jpeg") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of await storage.get(f.storage_key)) { chunks.push(Buffer.from(c as Buffer)); size += (c as Buffer).length; if (size > 256 * 1024) break; }
        taken = exifTakenAt(Buffer.concat(chunks));
      }
      await db.query("INSERT INTO photo_meta (file_id, project_id, taken_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [f.id, project.id, taken]);
    }
    return db.query(
      `SELECT f.id, f.name, f.size, f.created_at, u.name AS uploaded_by_name, m.album_id, a.name AS album_name, m.caption, m.location, m.tags,
              to_char(m.taken_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS taken_at,
              (SELECT json_agg(json_build_object('type', x.entity_type, 'id', x.entity_id)) FROM attachments x WHERE x.file_id = f.id) AS linked_to
         FROM files f JOIN photo_meta m ON m.file_id = f.id LEFT JOIN photo_albums a ON a.id = m.album_id LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE f.project_id = $1
          AND ($2::text IS NULL OR ($2 = 'none' AND m.album_id IS NULL) OR m.album_id::text = $2)
          AND ($3::text IS NULL OR $3 = ANY(m.tags))
          AND ($4::date IS NULL OR coalesce(m.taken_at, f.created_at)::date >= $4)
          AND ($5::date IS NULL OR coalesce(m.taken_at, f.created_at)::date <= $5)
        ORDER BY coalesce(m.taken_at, f.created_at) DESC LIMIT 500`,
      [project.id, q.album ?? null, q.tag?.toLowerCase() ?? null, q.from ?? null, q.to ?? null],
    );
  });

  app.patch<Id>("/photos/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; mime: string; uploaded_by: string | null }>(db, "files", req.params.id, user.id, "read", "Photo");
    if (!row.mime.startsWith("image/")) throw new HttpError(404, "Photo not found");
    if (!canWriteRecords(access.role) && row.uploaded_by !== user.id) throw new HttpError(403, "You do not have permission to do that");
    const b = z.object({
      albumId: z.uuid().nullable().optional(),
      caption: z.string().trim().max(500).nullable().optional(),
      location: z.string().trim().max(200).nullable().optional(),
      tags: z.array(z.string().trim().toLowerCase().min(1).max(50)).max(20).optional(),
      takenAt: z.iso.datetime({ local: true }).nullable().optional(),
    }).parse(req.body);
    if (b.albumId && !(await db.query("SELECT 1 FROM photo_albums WHERE id = $1 AND project_id = $2", [b.albumId, row.project_id])).length) throw new HttpError(400, "Album not found in this project");
    await db.tx(async (q) => {
      await q.query("INSERT INTO photo_meta (file_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [row.id, row.project_id]);
      await q.query(
        `UPDATE photo_meta SET album_id = CASE WHEN $2 THEN $3::uuid ELSE album_id END, caption = CASE WHEN $4 THEN $5 ELSE caption END,
                location = CASE WHEN $6 THEN $7 ELSE location END, tags = coalesce($8::text[], tags), taken_at = CASE WHEN $9 THEN $10::timestamptz ELSE taken_at END
          WHERE file_id = $1`,
        [row.id, b.albumId !== undefined, b.albumId ?? null, b.caption !== undefined, b.caption ?? null, b.location !== undefined, b.location ?? null, b.tags ? [...new Set(b.tags)] : null, b.takenAt !== undefined, b.takenAt ?? null],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "photo.update", entityType: "file", entityId: row.id, detail: b });
    });
    return { ok: true };
  });

  // ---------- Daily log sections ----------

  const entryInput = z.object({
    kind: z.enum(["delivery", "call", "safety_violation", "quantity", "waste"]),
    atTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM").nullable().optional(),
    party: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().min(1).max(2000),
    quantity: z.union([z.number(), z.string()]).transform(String).pipe(z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, "Quantity must be a number with up to 2 decimals")).nullable().optional(),
    unit: z.string().trim().max(20).nullable().optional(),
    costCodeId: z.uuid().nullable().optional(),
  });

  app.post<Id>("/daily-logs/:id/entries", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "daily_logs", req.params.id, user.id, "record.write", "Daily log");
    if (row.status === "signed") throw new HttpError(409, "A signed daily log cannot be changed");
    const b = entryInput.parse(req.body);
    if (b.kind === "quantity" && (b.quantity === null || b.quantity === undefined)) throw new HttpError(400, "Enter the quantity installed");
    if (b.costCodeId && !(await db.query("SELECT 1 FROM cost_codes WHERE id = $1 AND project_id = $2", [b.costCodeId, row.project_id])).length) throw new HttpError(400, "Unknown cost code");
    const entry = await db.tx(async (q) => {
      const [e] = await q.query<{ id: string }>(
        `INSERT INTO daily_log_entries (log_id, kind, at_time, party, description, quantity, unit, cost_code_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [row.id, b.kind, b.atTime ?? null, b.party ?? null, b.description, b.quantity ?? null, b.unit ?? null, b.costCodeId ?? null, user.id],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "daily_log.entry", entityType: "daily_log", entityId: row.id, detail: { kind: b.kind } });
      return e!;
    });
    return reply.code(201).send(entry);
  });

  app.delete<Id>("/daily-log-entries/:id", async (req) => {
    const user = requireUser(req);
    const [e] = await db.query<{ id: string; log_id: string }>("SELECT id, log_id FROM daily_log_entries WHERE id = $1", [z.uuid().catch("00000000-0000-0000-0000-000000000000").parse(req.params.id)]);
    if (!e) throw new HttpError(404, "Entry not found");
    const { row, access } = await loadInProject<{ id: string; project_id: string; status: string }>(db, "daily_logs", e.log_id, user.id, "record.write", "Entry");
    if (row.status === "signed") throw new HttpError(409, "A signed daily log cannot be changed");
    await db.tx(async (q) => {
      await q.query("DELETE FROM daily_log_entries WHERE id = $1", [e.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "daily_log.entry_delete", entityType: "daily_log", entityId: row.id });
    });
    return { ok: true };
  });

  /** Everything recorded elsewhere for the log's date: entries, equipment hours and time entered. */
  app.get<Id>("/daily-logs/:id/sections", async (req) => {
    const user = requireUser(req);
    const { row } = await loadInProject<{ id: string; project_id: string; log_date: string }>(db, "daily_logs", req.params.id, user.id, "read.full", "Daily log");
    const entries = await db.query(
      `SELECT e.id, e.kind, e.at_time, e.party, e.description, e.quantity::text, e.unit, c.code AS cost_code, u.name AS created_by_name
         FROM daily_log_entries e LEFT JOIN cost_codes c ON c.id = e.cost_code_id LEFT JOIN users u ON u.id = e.created_by
        WHERE e.log_id = $1 ORDER BY e.kind, e.at_time NULLS LAST, e.created_at`, [row.id]);
    const equipment = await db.query(
      `SELECT q.name, sum(l.hours_operated)::text AS hours_operated, sum(l.hours_idle)::text AS hours_idle
         FROM equipment_logs l JOIN equipment q ON q.id = l.equipment_id WHERE q.project_id = $1 AND l.log_date = $2 GROUP BY q.name ORDER BY q.name`,
      [row.project_id, row.log_date]);
    const time = await db.query(
      `SELECT coalesce(u.name, w.name) AS worker, sum(t.hours)::text AS hours, string_agg(DISTINCT t.status, ', ') AS status
         FROM timesheet_entries t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN workers w ON w.id = t.worker_id
        WHERE t.project_id = $1 AND t.work_date = $2 AND t.status <> 'rejected' GROUP BY 1 ORDER BY 1`,
      [row.project_id, row.log_date]);
    return { entries, equipment, time };
  });
};
