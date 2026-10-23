import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { decide, listSteps, startRound, type StepRow } from "../lib/approvals.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject } from "../lib/records.js";
import { INLINE_TYPES, isPdf, readUpload, storeFile } from "../lib/uploads.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const ATTACHABLE = ["task", "rfi", "submittal", "daily_log", "inspection", "punch_item", "observation", "incident", "change_event", "change_order", "invoice"] as const;
const ATTACH_TABLE: Record<(typeof ATTACHABLE)[number], string> = {
  task: "tasks", rfi: "rfis", submittal: "submittals", daily_log: "daily_logs", inspection: "inspections",
  punch_item: "punch_items", observation: "observations", incident: "incidents", change_event: "change_events",
  change_order: "change_orders", invoice: "invoices",
};

export const documentRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db, storage } = config;

  // ---------- Files ----------

  app.post<P>("/projects/:projectId/files", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const up = await readUpload(req);
    if (!up.file) throw new HttpError(400, "Choose a file to upload");
    const file = await db.tx(async (q) => {
      const f = await storeFile(q, storage, { orgId: project.org_id, projectId: project.id, userId: user.id, file: up.file! });
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "file.upload", entityType: "file", entityId: f.id, detail: { name: f.name, size: f.size } });
      return f;
    });
    return reply.code(201).send(file);
  });

  /** Photo library and general file list. `kind=image` filters to photos. */
  app.get<P & { Querystring: { kind?: string } }>("/projects/:projectId/files", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT f.id, f.name, f.mime, f.size, f.created_at, u.name AS uploaded_by_name,
              (SELECT json_agg(json_build_object('type', a.entity_type, 'id', a.entity_id)) FROM attachments a WHERE a.file_id = f.id) AS linked_to
         FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
        WHERE f.project_id = $1 AND ($2::text IS NULL OR f.mime LIKE 'image/%')
        ORDER BY f.created_at DESC LIMIT 500`,
      [req.params.projectId, req.query.kind === "image" ? "image" : null],
    );
  });

  app.get<Id & { Querystring: { inline?: string } }>("/files/:id/download", async (req, reply) => {
    const user = requireUser(req);
    const { row } = await loadInProject<{ project_id: string; storage_key: string; name: string; mime: string; size: string }>(db, "files", req.params.id, user.id, "read", "File");
    const inline = req.query.inline === "1" && INLINE_TYPES.has(row.mime);
    reply.header("Content-Type", inline ? row.mime : "application/octet-stream");
    reply.header("Content-Length", row.size);
    reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    reply.header("Cache-Control", "private, max-age=0");
    return reply.send(await storage.get(row.storage_key));
  });

  app.post("/attachments", async (req, reply) => {
    const user = requireUser(req);
    const body = z.object({ entityType: z.enum(ATTACHABLE), entityId: z.uuid(), fileId: z.uuid() }).parse(req.body);
    const { row: entity, access } = await loadInProject(db, ATTACH_TABLE[body.entityType], body.entityId, user.id, "record.write");
    const { row: file } = await loadInProject(db, "files", body.fileId, user.id, "read", "File");
    if (file.project_id !== entity.project_id) throw new HttpError(400, "File belongs to a different project");
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO attachments (entity_type, entity_id, file_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [body.entityType, body.entityId, body.fileId, user.id],
      );
      await audit(q, { orgId: access.project.org_id, projectId: entity.project_id, actorId: user.id, action: "attachment.add", entityType: body.entityType, entityId: body.entityId, detail: { fileId: body.fileId } });
    });
    return reply.code(201).send({ ok: true });
  });

  // ---------- Drawings ----------

  app.get<P & { Querystring: { discipline?: string } }>("/projects/:projectId/drawings", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT d.id, d.number, d.title, d.discipline, cur.revision AS current_revision, cur.issued_date, cur.set_name,
              cur.file_id AS current_file_id, cur.id AS current_revision_id,
              (SELECT count(*)::int FROM drawing_revisions r WHERE r.drawing_id = d.id) AS revision_count
         FROM drawings d
         LEFT JOIN LATERAL (SELECT * FROM drawing_revisions r WHERE r.drawing_id = d.id ORDER BY r.created_at DESC LIMIT 1) cur ON true
        WHERE d.project_id = $1 AND ($2::text IS NULL OR d.discipline = $2)
        ORDER BY d.discipline, d.number`,
      [req.params.projectId, req.query.discipline ?? null],
    );
  });

  /** Upload a sheet: creates the drawing on first upload of a number, otherwise adds a revision that becomes current. */
  app.post<P>("/projects/:projectId/drawings", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const up = await readUpload(req);
    const f = z.object({
      number: z.string().trim().min(1).max(40),
      title: z.string().trim().max(200).optional().default(""),
      discipline: z.string().trim().max(60).optional().default("General"),
      revision: z.string().trim().min(1).max(20),
      setName: z.string().trim().max(120).optional(),
      issuedDate: z.union([z.iso.date(), z.literal("")]).optional(),
    }).parse(up.fields);
    if (!up.file) throw new HttpError(400, "Choose a PDF to upload");
    if (!isPdf(up.file.data)) throw new HttpError(400, "Drawings must be PDF files");
    const result = await db.tx(async (q) => {
      let [drawing] = await q.query<{ id: string; title: string }>("SELECT id, title FROM drawings WHERE project_id = $1 AND number = $2", [project.id, f.number]);
      if (!drawing) {
        if (!f.title) throw new HttpError(400, "A new sheet needs a title");
        [drawing] = await q.query(`INSERT INTO drawings (project_id, number, title, discipline) VALUES ($1, $2, $3, $4) RETURNING id, title`, [project.id, f.number, f.title, f.discipline]);
      } else if (f.title && f.title !== drawing.title) {
        await q.query("UPDATE drawings SET title = $2 WHERE id = $1", [drawing.id, f.title]);
      }
      const dup = await q.query("SELECT 1 FROM drawing_revisions WHERE drawing_id = $1 AND revision = $2", [drawing!.id, f.revision]);
      if (dup.length) throw new HttpError(409, `Revision ${f.revision} of ${f.number} already exists`);
      const file = await storeFile(q, storage, { orgId: project.org_id, projectId: project.id, userId: user.id, file: up.file! });
      const [rev] = await q.query<{ id: string }>(
        `INSERT INTO drawing_revisions (drawing_id, revision, set_name, issued_date, file_id, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [drawing!.id, f.revision, f.setName || null, f.issuedDate || null, file.id, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "drawing.revision", entityType: "drawing", entityId: drawing!.id, detail: { number: f.number, revision: f.revision } });
      return { drawingId: drawing!.id, revisionId: rev!.id };
    });
    return reply.code(201).send(result);
  });

  app.get<Id>("/drawings/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject(db, "drawings", req.params.id, user.id, "read", "Drawing");
    const revisions = await db.query(
      `SELECT r.id, r.revision, r.set_name, r.issued_date, r.file_id, r.created_at, u.name AS uploaded_by_name,
              (SELECT coalesce(json_agg(json_build_object('id', m.id, 'file_id', m.file_id, 'tool', m.tool, 'note', m.note, 'created_at', m.created_at, 'by', mu.name) ORDER BY m.created_at), '[]')
                 FROM markup_sets m LEFT JOIN users mu ON mu.id = m.created_by WHERE m.revision_id = r.id) AS markups
         FROM drawing_revisions r LEFT JOIN users u ON u.id = r.uploaded_by
        WHERE r.drawing_id = $1 ORDER BY r.created_at DESC`,
      [req.params.id],
    );
    const rfis = await db.query("SELECT id, number, subject, status FROM rfis WHERE drawing_id = $1 ORDER BY number", [req.params.id]);
    return { ...row, revisions, rfis, myRole: access.role, tools: config.documentTools };
  });

  /** Upload a marked-up copy (e.g. saved from OpenDraft). The issued sheet itself is never modified. */
  app.post<Id>("/drawing-revisions/:id/markups", async (req, reply) => {
    const user = requireUser(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, "Revision not found");
    const [rev] = await db.query<{ drawing_id: string }>("SELECT drawing_id FROM drawing_revisions WHERE id = $1", [req.params.id]);
    if (!rev) throw new HttpError(404, "Revision not found");
    const { row: drawing, access } = await loadInProject(db, "drawings", rev.drawing_id, user.id, "record.write", "Revision");
    const up = await readUpload(req);
    if (!up.file || !isPdf(up.file.data)) throw new HttpError(400, "Upload the marked-up PDF");
    const tool = z.string().trim().max(40).default("manual").parse(up.fields.tool || undefined);
    const note = up.fields.note?.slice(0, 1000) || null;
    const id = await db.tx(async (q) => {
      const file = await storeFile(q, storage, { orgId: access.project.org_id, projectId: drawing.project_id, userId: user.id, file: up.file! });
      const [m] = await q.query<{ id: string }>(`INSERT INTO markup_sets (revision_id, file_id, tool, note, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [req.params.id, file.id, tool, note, user.id]);
      await audit(q, { orgId: access.project.org_id, projectId: drawing.project_id, actorId: user.id, action: "drawing.markup", entityType: "drawing", entityId: rev.drawing_id, detail: { tool, note } });
      return m!.id;
    });
    return reply.code(201).send({ id });
  });

  // ---------- Folders & documents ----------

  app.get<P>("/projects/:projectId/folders", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query("SELECT id, parent_id, name FROM folders WHERE project_id = $1 ORDER BY name", [req.params.projectId]);
  });

  app.post<P>("/projects/:projectId/folders", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const body = z.object({ name: z.string().trim().min(1).max(120), parentId: z.uuid().nullable().optional() }).parse(req.body);
    if (body.parentId) {
      const p = await db.query("SELECT 1 FROM folders WHERE id = $1 AND project_id = $2", [body.parentId, project.id]);
      if (!p.length) throw new HttpError(400, "Parent folder not found");
    }
    const [f] = await db.query(`INSERT INTO folders (project_id, parent_id, name) VALUES ($1, $2, $3) RETURNING *`, [project.id, body.parentId ?? null, body.name]);
    return reply.code(201).send(f);
  });

  app.get<P & { Querystring: { folderId?: string } }>("/projects/:projectId/documents", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    const folder = req.query.folderId && isUuid(req.query.folderId) ? req.query.folderId : null;
    return db.query(
      `SELECT d.id, d.name, d.status, d.folder_id, d.updated_at, v.version, v.file_id, u.name AS updated_by_name
         FROM documents d
         JOIN LATERAL (SELECT * FROM document_versions v WHERE v.document_id = d.id ORDER BY v.version DESC LIMIT 1) v ON true
         LEFT JOIN users u ON u.id = v.created_by
        WHERE d.project_id = $1 AND (d.folder_id IS NOT DISTINCT FROM $2::uuid)
        ORDER BY d.name`,
      [req.params.projectId, folder],
    );
  });

  app.post<P>("/projects/:projectId/documents", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const up = await readUpload(req);
    if (!up.file) throw new HttpError(400, "Choose a file to upload");
    const folderId = up.fields.folderId && isUuid(up.fields.folderId) ? up.fields.folderId : null;
    if (folderId && !(await db.query("SELECT 1 FROM folders WHERE id = $1 AND project_id = $2", [folderId, project.id])).length) {
      throw new HttpError(400, "Folder not found");
    }
    const name = z.string().trim().min(1).max(200).parse(up.fields.name || up.file.name);
    const doc = await db.tx(async (q) => {
      const file = await storeFile(q, storage, { orgId: project.org_id, projectId: project.id, userId: user.id, file: up.file! });
      const [d] = await q.query<{ id: string }>(`INSERT INTO documents (project_id, folder_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [project.id, folderId, name, user.id]);
      await q.query(`INSERT INTO document_versions (document_id, version, file_id, note, created_by) VALUES ($1, 1, $2, $3, $4)`, [d!.id, file.id, up.fields.note || null, user.id]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "document.create", entityType: "document", entityId: d!.id, detail: { name } });
      return d!;
    });
    return reply.code(201).send(doc);
  });

  app.post<Id>("/documents/:id/versions", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; name: string }>(db, "documents", req.params.id, user.id, "record.write", "Document");
    const up = await readUpload(req);
    if (!up.file) throw new HttpError(400, "Choose a file to upload");
    const version = await db.tx(async (q) => {
      await q.query("SELECT id FROM documents WHERE id = $1 FOR UPDATE", [row.id]);
      const [v] = await q.query<{ n: number }>("SELECT max(version)::int + 1 AS n FROM document_versions WHERE document_id = $1", [row.id]);
      const file = await storeFile(q, storage, { orgId: access.project.org_id, projectId: row.project_id, userId: user.id, file: up.file! });
      await q.query(`INSERT INTO document_versions (document_id, version, file_id, note, created_by) VALUES ($1, $2, $3, $4, $5)`, [row.id, v!.n, file.id, up.fields.note || null, user.id]);
      // A new version invalidates any approval in flight or granted for the old one.
      await q.query(`UPDATE approval_steps SET status = 'skipped' WHERE entity_type = 'document' AND entity_id = $1 AND status = 'pending'`, [row.id]);
      await q.query("UPDATE documents SET status = 'draft', updated_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "document.version", entityType: "document", entityId: row.id, detail: { name: row.name, version: v!.n } });
      return v!.n;
    });
    return reply.code(201).send({ version });
  });

  app.get<Id>("/documents/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject(db, "documents", req.params.id, user.id, "read", "Document");
    const versions = await db.query(
      `SELECT v.id, v.version, v.file_id, v.note, v.created_at, u.name AS created_by_name, f.name AS file_name, f.size
         FROM document_versions v JOIN files f ON f.id = v.file_id LEFT JOIN users u ON u.id = v.created_by
        WHERE v.document_id = $1 ORDER BY v.version DESC`,
      [req.params.id],
    );
    return { ...row, versions, approvals: await listSteps(db, "document", req.params.id), myRole: access.role, myId: user.id };
  });

  app.post<Id>("/documents/:id/submit", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "documents", req.params.id, user.id, "record.write", "Document");
    const body = z.object({ approverIds: z.array(z.uuid()).min(1).max(10) }).parse(req.body);
    if (row.status === "in_review") throw new HttpError(409, "Already in review");
    return db.tx(async (q) => {
      for (const id of body.approverIds) await assertProjectMember(q, row.project_id, id, "Approver");
      const round = await startRound(q, "document", row.id, body.approverIds);
      await q.query("UPDATE documents SET status = 'in_review', updated_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "document.submit", entityType: "document", entityId: row.id, detail: { round, approvers: body.approverIds.length } });
      await config.notify(q, body.approverIds.slice(0, 1), { kind: "approval", title: "A document is waiting for your approval", link: `/documents/${row.id}`, projectId: row.project_id, actorId: user.id });
      return { ok: true, round };
    });
  });

  /** Decide the current approval step of a document or submittal. */
  app.post<Id>("/approval-steps/:id/decide", async (req) => {
    const user = requireUser(req);
    const body = z.object({
      decision: z.enum(["approved", "approved_as_noted", "revise_resubmit", "rejected"]),
      comment: z.string().trim().max(4000).optional(),
    }).parse(req.body);
    if (!isUuid(req.params.id)) throw new HttpError(404, "Approval step not found");
    const [step] = await db.query<StepRow>("SELECT * FROM approval_steps WHERE id = $1", [req.params.id]);
    if (!step) throw new HttpError(404, "Approval step not found");
    const table = step.entity_type === "document" ? "documents" : "submittals";
    const { row, access } = await loadInProject<{ project_id: string; id: string; created_by: string | null }>(db, table, step.entity_id, user.id, "read", "Approval step");
    if (step.entity_type === "document" && body.decision === "approved_as_noted") throw new HttpError(400, "Documents are approved or rejected");
    if (step.entity_type === "document" && body.decision === "revise_resubmit") throw new HttpError(400, "Documents are approved or rejected");
    return db.tx(async (q) => {
      const outcome = await decide(q, step, user.id, body.decision, body.comment || null);
      if (outcome) {
        const status = step.entity_type === "document" ? (outcome === "rejected" ? "rejected" : "approved") : outcome;
        await q.query(`UPDATE ${table} SET status = $2, updated_at = now() WHERE id = $1`, [row.id, status]);
        if (row.created_by) await config.notify(q, [row.created_by], { kind: "approval", title: `Your ${step.entity_type} was ${status.replace(/_/g, " ")}`, link: `/${table}/${row.id}`, projectId: row.project_id, actorId: user.id });
      } else {
        const [next] = await q.query<{ approver_id: string }>(
          `SELECT approver_id FROM approval_steps WHERE entity_type = $1 AND entity_id = $2 AND round = $3 AND status = 'pending' ORDER BY seq LIMIT 1`,
          [step.entity_type, step.entity_id, step.round],
        );
        if (next) await config.notify(q, [next.approver_id], { kind: "approval", title: `A ${step.entity_type} is waiting for your approval`, link: `/${table}/${row.id}`, projectId: row.project_id, actorId: user.id });
      }
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: `${step.entity_type}.decision`, entityType: step.entity_type, entityId: row.id, detail: { decision: body.decision, comment: body.comment, outcome } });
      return { ok: true, outcome };
    });
  });

  /** Everything waiting on the signed-in user, across projects. */
  app.get("/me/approvals", async (req) => {
    const user = requireUser(req);
    return db.query(
      `SELECT s.id, s.entity_type, s.entity_id, s.created_at,
              coalesce(d.name, 'Submittal #' || sb.number || ' ' || sb.title) AS title, coalesce(d.project_id, sb.project_id) AS project_id
         FROM approval_steps s
         LEFT JOIN documents d ON s.entity_type = 'document' AND d.id = s.entity_id
         LEFT JOIN submittals sb ON s.entity_type = 'submittal' AND sb.id = s.entity_id
        WHERE s.approver_id = $1 AND s.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM approval_steps e WHERE e.entity_type = s.entity_type AND e.entity_id = s.entity_id AND e.round = s.round AND e.seq < s.seq AND e.status = 'pending')
        ORDER BY s.created_at`,
      [user.id],
    );
  });

  // ---------- Specifications ----------

  app.get<P>("/projects/:projectId/specs", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT s.id, s.number, s.title, s.file_id,
              (SELECT count(*)::int FROM submittals sb WHERE sb.spec_section_id = s.id) AS submittal_count
         FROM spec_sections s WHERE s.project_id = $1 ORDER BY s.number`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/specs", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const multipart = req.isMultipart();
    const up = multipart ? await readUpload(req) : { fields: req.body as Record<string, string>, file: null };
    const f = z.object({
      number: z.string().trim().regex(/^\d{2}( ?\d{2}){0,2}(\.\d+)?$/, "Use a MasterFormat number like 03 30 00"),
      title: z.string().trim().min(1).max(200),
    }).parse(up.fields);
    const spec = await db.tx(async (q) => {
      if ((await q.query("SELECT 1 FROM spec_sections WHERE project_id = $1 AND number = $2", [project.id, f.number])).length) {
        throw new HttpError(409, `Section ${f.number} already exists`);
      }
      const file = up.file ? await storeFile(q, storage, { orgId: project.org_id, projectId: project.id, userId: user.id, file: up.file }) : null;
      const [s] = await q.query<{ id: string }>(`INSERT INTO spec_sections (project_id, number, title, file_id) VALUES ($1, $2, $3, $4) RETURNING *`, [project.id, f.number, f.title, file?.id ?? null]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "spec.create", entityType: "spec_section", entityId: s!.id, detail: f });
      return s;
    });
    return reply.code(201).send(spec);
  });
};
