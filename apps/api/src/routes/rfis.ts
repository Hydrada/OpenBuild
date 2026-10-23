import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import type { Queryable } from "../db/db.js";
import { listSteps, startRound } from "../lib/approvals.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { requireProject } from "../lib/permissions.js";
import { assertProjectMember, loadInProject, nextNumber, toSet } from "../lib/records.js";

type P = { Params: { projectId: string } };
type Id = { Params: { id: string } };

const impact = z.enum(["tbd", "yes", "no"]);
const rfiInput = z.object({
  subject: z.string().trim().min(1).max(300),
  question: z.string().trim().min(1).max(20000),
  assigneeId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  drawingId: z.uuid().nullable().optional(),
  specSectionId: z.uuid().nullable().optional(),
  costImpact: impact.optional(),
  scheduleImpact: impact.optional(),
  draft: z.boolean().optional(),
});
const RFI_COLS = {
  subject: "subject", question: "question", assigneeId: "assignee_id", dueDate: "due_date", drawingId: "drawing_id",
  specSectionId: "spec_section_id", costImpact: "cost_impact", scheduleImpact: "schedule_impact",
};

const submittalInput = z.object({
  title: z.string().trim().min(1).max(300),
  type: z.enum(["shop_drawing", "product_data", "sample", "mockup", "other"]).default("shop_drawing"),
  specSectionId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  reviewerIds: z.array(z.uuid()).max(10).default([]),
});

export const rfiRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  async function checkRefs(q: Queryable, projectId: string, b: { drawingId?: string | null; specSectionId?: string | null; assigneeId?: string | null }) {
    if (b.assigneeId) await assertProjectMember(q, projectId, b.assigneeId);
    if (b.drawingId && !(await q.query("SELECT 1 FROM drawings WHERE id = $1 AND project_id = $2", [b.drawingId, projectId])).length) throw new HttpError(400, "Drawing not found in this project");
    if (b.specSectionId && !(await q.query("SELECT 1 FROM spec_sections WHERE id = $1 AND project_id = $2", [b.specSectionId, projectId])).length) throw new HttpError(400, "Spec section not found in this project");
  }

  // ---------- RFIs ----------

  app.get<P & { Querystring: { status?: string } }>("/projects/:projectId/rfis", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT r.id, r.number, r.subject, r.status, r.due_date, r.created_at, r.cost_impact, r.schedule_impact,
              a.name AS assignee_name, r.assignee_id, d.number AS drawing_number,
              (r.status IN ('open') AND r.due_date < current_date) AS overdue
         FROM rfis r LEFT JOIN users a ON a.id = r.assignee_id LEFT JOIN drawings d ON d.id = r.drawing_id
        WHERE r.project_id = $1 AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.number DESC`,
      [req.params.projectId, req.query.status || null],
    );
  });

  app.post<P>("/projects/:projectId/rfis", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = rfiInput.parse(req.body);
    const rfi = await db.tx(async (q) => {
      await checkRefs(q, project.id, b);
      const number = await nextNumber(q, "rfis", project.id);
      const [r] = await q.query<{ id: string; number: number }>(
        `INSERT INTO rfis (project_id, number, subject, question, status, assignee_id, due_date, drawing_id, spec_section_id, cost_impact, schedule_impact, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, number`,
        [project.id, number, b.subject, b.question, b.draft ? "draft" : "open", b.assigneeId ?? null, b.dueDate ?? null, b.drawingId ?? null, b.specSectionId ?? null, b.costImpact ?? "tbd", b.scheduleImpact ?? "tbd", user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "rfi.create", entityType: "rfi", entityId: r!.id, detail: { number, subject: b.subject } });
      if (!b.draft) await config.notify(q, [b.assigneeId], { kind: "rfi", title: `RFI #${number} needs your answer: ${b.subject}`, link: `/rfis/${r!.id}`, projectId: project.id, actorId: user.id });
      return r!;
    });
    return reply.code(201).send(rfi);
  });

  app.get<Id>("/rfis/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string }>(db, "rfis", req.params.id, user.id, "read", "RFI");
    const [detail] = await db.query(
      `SELECT r.*, a.name AS assignee_name, c.name AS created_by_name, d.number AS drawing_number, s.number AS spec_number, s.title AS spec_title
         FROM rfis r LEFT JOIN users a ON a.id = r.assignee_id LEFT JOIN users c ON c.id = r.created_by
         LEFT JOIN drawings d ON d.id = r.drawing_id LEFT JOIN spec_sections s ON s.id = r.spec_section_id
        WHERE r.id = $1`,
      [row.id],
    );
    const responses = await db.query(
      `SELECT x.id, x.body, x.is_official, x.created_at, u.name AS author_name FROM rfi_responses x LEFT JOIN users u ON u.id = x.author_id
        WHERE x.rfi_id = $1 ORDER BY x.created_at`,
      [row.id],
    );
    const attachments = await db.query(
      `SELECT f.id, f.name, f.mime, f.size FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'rfi' AND a.entity_id = $1 ORDER BY a.created_at`,
      [row.id],
    );
    return { ...detail, responses, attachments, myRole: access.role, myId: user.id };
  });

  app.patch<Id>("/rfis/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number; assignee_id: string | null; subject: string }>(db, "rfis", req.params.id, user.id, "record.write", "RFI");
    if (row.status === "closed") throw new HttpError(409, "Reopen the RFI before editing it");
    const b = rfiInput.partial().parse(req.body);
    const { sets, values } = toSet(b, RFI_COLS);
    if (b.draft === false && row.status === "draft") sets.push("status = 'open'");
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    return db.tx(async (q) => {
      await checkRefs(q, row.project_id, b);
      const [r] = await q.query(`UPDATE rfis SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, [row.id, ...values]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "rfi.update", entityType: "rfi", entityId: row.id, detail: b });
      if (b.assigneeId && b.assigneeId !== row.assignee_id) {
        await config.notify(q, [b.assigneeId], { kind: "rfi", title: `RFI #${row.number} is in your court: ${row.subject}`, link: `/rfis/${row.id}`, projectId: row.project_id, actorId: user.id });
      }
      return r;
    });
  });

  /**
   * Anyone who can see the RFI and is its assignee, or any contributor+, may respond.
   * Marking a response official (which answers the RFI) needs manager/admin or the assignee.
   */
  app.post<Id>("/rfis/:id/responses", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; assignee_id: string | null; created_by: string | null; number: number }>(db, "rfis", req.params.id, user.id, "read", "RFI");
    const b = z.object({ body: z.string().trim().min(1).max(20000), official: z.boolean().default(false) }).parse(req.body);
    const isAssignee = row.assignee_id === user.id;
    const canWrite = access.role !== "viewer";
    if (!isAssignee && !canWrite) throw new HttpError(403, "You do not have permission to do that");
    if (b.official && !(isAssignee || access.role === "admin" || access.role === "manager")) throw new HttpError(403, "Only the assignee or a manager can give the official answer");
    if (row.status === "closed" || row.status === "draft") throw new HttpError(409, `The RFI is ${row.status}`);
    const res = await db.tx(async (q) => {
      if (b.official) await q.query("UPDATE rfi_responses SET is_official = false WHERE rfi_id = $1", [row.id]);
      const [x] = await q.query(`INSERT INTO rfi_responses (rfi_id, body, is_official, author_id) VALUES ($1, $2, $3, $4) RETURNING *`, [row.id, b.body, b.official, user.id]);
      if (b.official) await q.query("UPDATE rfis SET status = 'answered', answered_at = now(), updated_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: b.official ? "rfi.answer" : "rfi.respond", entityType: "rfi", entityId: row.id, detail: { number: row.number } });
      await config.notify(q, [row.created_by, row.assignee_id], { kind: "rfi", title: `${b.official ? "Official answer" : "New response"} on RFI #${row.number}`, link: `/rfis/${row.id}`, projectId: row.project_id, actorId: user.id });
      return x;
    });
    return reply.code(201).send(res);
  });

  app.post<Id>("/rfis/:id/status", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; created_by: string | null; number: number }>(db, "rfis", req.params.id, user.id, "read", "RFI");
    const b = z.object({ status: z.enum(["open", "closed"]) }).parse(req.body);
    const manager = access.role === "admin" || access.role === "manager";
    if (!manager && !(row.created_by === user.id && access.role !== "viewer")) throw new HttpError(403, "Only the creator or a manager can open or close an RFI");
    if (b.status === "closed" && row.status === "closed") throw new HttpError(409, "Already closed");
    return db.tx(async (q) => {
      const [r] = await q.query(
        `UPDATE rfis SET status = $2, closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id, b.status],
      );
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: b.status === "closed" ? "rfi.close" : "rfi.reopen", entityType: "rfi", entityId: row.id, detail: { number: row.number } });
      return r;
    });
  });

  // ---------- Submittals ----------

  app.get<P>("/projects/:projectId/submittals", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read");
    return db.query(
      `SELECT s.id, s.number, s.revision, s.title, s.type, s.status, s.due_date, sp.number AS spec_number,
              (SELECT u.name FROM approval_steps st JOIN users u ON u.id = st.approver_id
                WHERE st.entity_type = 'submittal' AND st.entity_id = s.id AND st.status = 'pending' ORDER BY st.round DESC, st.seq LIMIT 1) AS ball_in_court
         FROM submittals s LEFT JOIN spec_sections sp ON sp.id = s.spec_section_id
        WHERE s.project_id = $1 ORDER BY s.number DESC, s.revision DESC`,
      [req.params.projectId],
    );
  });

  app.post<P>("/projects/:projectId/submittals", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = submittalInput.parse(req.body);
    const s = await db.tx(async (q) => {
      await checkRefs(q, project.id, b);
      for (const r of b.reviewerIds) await assertProjectMember(q, project.id, r, "Reviewer");
      const number = await nextNumber(q, "submittals", project.id);
      const [row] = await q.query<{ id: string; number: number }>(
        `INSERT INTO submittals (project_id, number, title, type, spec_section_id, due_date, reviewer_ids, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, number`,
        [project.id, number, b.title, b.type, b.specSectionId ?? null, b.dueDate ?? null, b.reviewerIds, user.id],
      );
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "submittal.create", entityType: "submittal", entityId: row!.id, detail: { number, title: b.title } });
      return row!;
    });
    return reply.code(201).send(s);
  });

  app.get<Id>("/submittals/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; number: number }>(db, "submittals", req.params.id, user.id, "read", "Submittal");
    const [detail] = await db.query(
      `SELECT s.*, sp.number AS spec_number, sp.title AS spec_title, c.name AS created_by_name,
              (SELECT coalesce(json_agg(json_build_object('id', u.id, 'name', u.name) ORDER BY array_position(s.reviewer_ids, u.id)), '[]') FROM users u WHERE u.id = ANY(s.reviewer_ids)) AS reviewers
         FROM submittals s LEFT JOIN spec_sections sp ON sp.id = s.spec_section_id LEFT JOIN users c ON c.id = s.created_by WHERE s.id = $1`,
      [row.id],
    );
    const revisions = await db.query("SELECT id, revision, status FROM submittals WHERE project_id = $1 AND number = $2 ORDER BY revision", [row.project_id, row.number]);
    const attachments = await db.query(
      `SELECT f.id, f.name, f.mime, f.size FROM attachments a JOIN files f ON f.id = a.file_id WHERE a.entity_type = 'submittal' AND a.entity_id = $1 ORDER BY a.created_at`,
      [row.id],
    );
    return { ...detail, revisions, attachments, approvals: await listSteps(db, "submittal", row.id), myRole: access.role, myId: user.id };
  });

  app.patch<Id>("/submittals/:id", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string }>(db, "submittals", req.params.id, user.id, "record.write", "Submittal");
    if (row.status !== "draft") throw new HttpError(409, "Only draft submittals can be edited");
    const b = submittalInput.partial().parse(req.body);
    const { sets, values } = toSet(b, { title: "title", type: "type", specSectionId: "spec_section_id", dueDate: "due_date", reviewerIds: "reviewer_ids" });
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    return db.tx(async (q) => {
      await checkRefs(q, row.project_id, b);
      for (const r of b.reviewerIds ?? []) await assertProjectMember(q, row.project_id, r, "Reviewer");
      const [r] = await q.query(`UPDATE submittals SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`, [row.id, ...values]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "submittal.update", entityType: "submittal", entityId: row.id, detail: b });
      return r;
    });
  });

  /** Sends a draft submittal into its review workflow (reviewers decide in order). */
  app.post<Id>("/submittals/:id/submit", async (req) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; reviewer_ids: string[]; number: number; title: string }>(db, "submittals", req.params.id, user.id, "record.write", "Submittal");
    if (row.status !== "draft") throw new HttpError(409, "Only draft submittals can be submitted");
    if (!row.reviewer_ids.length) throw new HttpError(400, "Add at least one reviewer first");
    return db.tx(async (q) => {
      const round = await startRound(q, "submittal", row.id, row.reviewer_ids);
      await q.query("UPDATE submittals SET status = 'in_review', updated_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "submittal.submit", entityType: "submittal", entityId: row.id, detail: { number: row.number, round } });
      await config.notify(q, [row.reviewer_ids[0]], { kind: "approval", title: `Submittal #${row.number} is waiting for your review: ${row.title}`, link: `/submittals/${row.id}`, projectId: row.project_id, actorId: user.id });
      return { ok: true };
    });
  });

  /** After "revise and resubmit" or "rejected": opens revision N+1 as a new draft with the same reviewers. */
  app.post<Id>("/submittals/:id/revise", async (req, reply) => {
    const user = requireUser(req);
    const { row, access } = await loadInProject<{ project_id: string; id: string; status: string; number: number; revision: number; title: string; type: string; spec_section_id: string | null; due_date: string | null; reviewer_ids: string[] }>(db, "submittals", req.params.id, user.id, "record.write", "Submittal");
    if (!["revise_resubmit", "rejected"].includes(row.status)) throw new HttpError(409, "Only returned submittals can be revised");
    const created = await db.tx(async (q) => {
      const [latest] = await q.query<{ r: number }>("SELECT max(revision)::int AS r FROM submittals WHERE project_id = $1 AND number = $2", [row.project_id, row.number]);
      if (latest!.r !== row.revision) throw new HttpError(409, "A newer revision already exists");
      const [n] = await q.query<{ id: string }>(
        `INSERT INTO submittals (project_id, number, revision, title, type, spec_section_id, due_date, reviewer_ids, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [row.project_id, row.number, row.revision + 1, row.title, row.type, row.spec_section_id, row.due_date, row.reviewer_ids, user.id],
      );
      await q.query("UPDATE submittals SET status = 'closed', updated_at = now() WHERE id = $1", [row.id]);
      await audit(q, { orgId: access.project.org_id, projectId: row.project_id, actorId: user.id, action: "submittal.revise", entityType: "submittal", entityId: n!.id, detail: { number: row.number, revision: row.revision + 1 } });
      return n!;
    });
    return reply.code(201).send(created);
  });
};
