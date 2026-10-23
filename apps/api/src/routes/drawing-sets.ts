import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { requireProject } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";
import { detectSheets, disciplineOf, splitPages } from "../lib/sheets.js";
import { isPdf, readUpload, storeFile } from "../lib/uploads.js";

type P = { Params: { projectId: string } };

/**
 * Multi-sheet drawing sets: upload one PDF, review the sheet numbers and titles read from each title block, then
 * publish every page as a revision of its sheet in one step.
 */
export const drawingSetRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db, storage } = config;

  async function readAll(key: string): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const c of await storage.get(key)) chunks.push(Buffer.from(c as Buffer));
    return new Uint8Array(Buffer.concat(chunks));
  }

  app.post<P>("/projects/:projectId/drawing-sets/analyze", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const up = await readUpload(req);
    if (!up.file) throw new HttpError(400, "Choose a PDF drawing set");
    if (!isPdf(up.file.data)) throw new HttpError(400, "Drawing sets must be PDF files");
    let pages;
    try {
      pages = await detectSheets(up.file.data);
    } catch {
      throw new HttpError(400, "That PDF could not be read");
    }
    if (pages.length > 1000) throw new HttpError(400, "Sets are limited to 1,000 sheets");
    const file = await db.tx((q) => storeFile(q, storage, { orgId: project.org_id, projectId: project.id, userId: user.id, file: up.file! }));
    const existing = new Map((await db.query<{ number: string; title: string; latest: string | null }>(
      `SELECT d.number, d.title, (SELECT r.revision FROM drawing_revisions r WHERE r.drawing_id = d.id ORDER BY r.created_at DESC LIMIT 1) AS latest
         FROM drawings d WHERE d.project_id = $1`, [project.id])).map((d) => [d.number, d]));
    return reply.code(201).send({
      fileId: file.id,
      pages: pages.map((p) => ({ ...p, existing: p.number ? existing.get(p.number) ?? null : null })),
    });
  });

  app.post<P>("/projects/:projectId/drawing-sets/import", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({
      fileId: z.uuid(),
      revision: z.string().trim().min(1).max(20),
      setName: z.string().trim().max(120).nullable().optional(),
      issuedDate: z.iso.date().nullable().optional(),
      sheets: z.array(z.object({
        page: z.number().int().min(1),
        number: z.string().trim().min(1).max(40),
        title: z.string().trim().max(200).default(""),
        discipline: z.string().trim().max(60).optional(),
        revision: z.string().trim().min(1).max(20).optional(),
      })).min(1).max(1000),
    }).parse(req.body);
    const numbers = b.sheets.map((s) => s.number.toUpperCase());
    const dupNumber = numbers.find((n, i) => numbers.indexOf(n) !== i);
    if (dupNumber) throw new HttpError(400, `Sheet ${dupNumber} appears twice in this set`);
    const { row: file } = await loadInProject<{ id: string; project_id: string; storage_key: string; mime: string; name: string }>(db, "files", b.fileId, user.id, "record.write", "File");
    if (file.project_id !== project.id) throw new HttpError(400, "That file belongs to another project");
    const parts = await splitPages(await readAll(file.storage_key), b.sheets.map((s) => s.page)).catch((e: Error) => { throw new HttpError(400, e.message); });

    const result = await db.tx(async (q) => {
      const created: { number: string; drawingId: string; revision: string; newSheet: boolean }[] = [];
      for (const s of b.sheets) {
        const revision = s.revision ?? b.revision;
        let [drawing] = await q.query<{ id: string; title: string }>("SELECT id, title FROM drawings WHERE project_id = $1 AND number = $2", [project.id, s.number]);
        const newSheet = !drawing;
        if (!drawing) {
          if (!s.title) throw new HttpError(400, `Sheet ${s.number} is new and needs a title`);
          [drawing] = await q.query(`INSERT INTO drawings (project_id, number, title, discipline) VALUES ($1, $2, $3, $4) RETURNING id, title`, [project.id, s.number, s.title, s.discipline ?? disciplineOf(s.number)]);
        } else if (s.title && s.title !== drawing.title) {
          await q.query("UPDATE drawings SET title = $2 WHERE id = $1", [drawing.id, s.title]);
        }
        if ((await q.query("SELECT 1 FROM drawing_revisions WHERE drawing_id = $1 AND revision = $2", [drawing!.id, revision])).length) {
          throw new HttpError(409, `Revision ${revision} of ${s.number} already exists`);
        }
        const stored = await storeFile(q, storage, { orgId: project.org_id, projectId: project.id, userId: user.id, file: { name: `${s.number}-rev${revision}.pdf`, mime: "application/pdf", data: Buffer.from(parts.get(s.page)!) } });
        await q.query(
          `INSERT INTO drawing_revisions (drawing_id, revision, set_name, issued_date, file_id, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)`,
          [drawing!.id, revision, b.setName || null, b.issuedDate || null, stored.id, user.id],
        );
        created.push({ number: s.number, drawingId: drawing!.id, revision, newSheet });
      }
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "drawing.set_import", entityType: "project", entityId: project.id, detail: { set: b.setName ?? null, sheets: created.length } });
      return created;
    });
    return reply.code(201).send({ imported: result.length, newSheets: result.filter((r) => r.newSheet).length, sheets: result });
  });
};
