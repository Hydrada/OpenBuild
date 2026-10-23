import { createHash, randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { requireProject } from "../lib/permissions.js";
import { loadInProject } from "../lib/records.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const email = z.string().trim().toLowerCase().email().max(254);
/** Threads are tagged in the subject so replies (inbound) land back on the right conversation. */
const tag = (n: number) => `[#E-${n}]`;
const TAG_RE = /\[#E-(\d{1,9})\]/;

/**
 * Project email: send from the project (through the configured SMTP server, or logged only when there is none),
 * keep every message and reply in threads, and accept inbound replies posted by a mail provider to a secret URL.
 */
export const emailRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db, storage } = config;

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/emails", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    return db.query(
      `SELECT DISTINCT ON (e.thread_number) e.thread_number, e.subject, e.direction, e.from_address, e.created_at, e.status,
              (SELECT count(*)::int FROM project_emails x WHERE x.project_id = e.project_id AND x.thread_number = e.thread_number) AS messages
         FROM project_emails e WHERE e.project_id = $1 ORDER BY e.thread_number, e.created_at DESC`,
      [req.params.projectId],
    ).then((rows) => (rows as { created_at: string }[]).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
  });

  app.get<{ Params: { projectId: string; thread: string } }>("/projects/:projectId/emails/:thread", async (req) => {
    const user = requireUser(req);
    await requireProject(db, user.id, req.params.projectId, "read.full");
    const n = z.coerce.number().int().min(1).parse(req.params.thread);
    const messages = await db.query(
      `SELECT e.id, e.direction, e.from_address, e.to_addresses, e.cc_addresses, e.subject, e.body, e.status, e.error, e.created_at, u.name AS sent_by_name,
              coalesce((SELECT json_agg(json_build_object('id', f.id, 'name', f.name)) FROM project_email_files ef JOIN files f ON f.id = ef.file_id WHERE ef.email_id = e.id), '[]') AS files
         FROM project_emails e LEFT JOIN users u ON u.id = e.sent_by WHERE e.project_id = $1 AND e.thread_number = $2 ORDER BY e.created_at`,
      [req.params.projectId, n]);
    if (!messages.length) throw new HttpError(404, "Thread not found");
    return { thread_number: n, messages };
  });

  app.post<{ Params: { projectId: string } }>("/projects/:projectId/emails", async (req, reply) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "record.write");
    const b = z.object({
      to: z.array(email).min(1).max(50),
      cc: z.array(email).max(50).default([]),
      subject: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(50000),
      fileIds: z.array(z.uuid()).max(20).default([]),
      thread: z.number().int().min(1).optional(),
    }).parse(req.body);
    const files: { id: string; name: string; storage_key: string; size: string }[] = [];
    for (const id of b.fileIds) {
      const { row } = await loadInProject<{ id: string; project_id: string; name: string; storage_key: string; size: string }>(db, "files", id, user.id, "read.full", "File");
      if (row.project_id !== project.id) throw new HttpError(400, "Attachments must belong to this project");
      files.push(row);
    }
    if (files.reduce((n, f) => n + Number(f.size), 0) > 20 * 1024 * 1024) throw new HttpError(400, "Attachments are limited to 20 MB per email");
    const [me] = await db.query<{ email: string; name: string }>("SELECT email, name FROM users WHERE id = $1", [user.id]);
    const thread = b.thread ?? ((await db.query<{ n: number }>("SELECT coalesce(max(thread_number), 0)::int + 1 AS n FROM project_emails WHERE project_id = $1", [project.id]))[0]!.n);
    if (b.thread && !(await db.query("SELECT 1 FROM project_emails WHERE project_id = $1 AND thread_number = $2", [project.id, b.thread])).length) throw new HttpError(400, "Thread not found");
    const subject = TAG_RE.test(b.subject) ? b.subject : `${b.subject} ${tag(thread)}`;
    let status: "sent" | "failed" | "logged" = "logged";
    let error: string | null = null;
    if (config.mailer) {
      const attachments = [];
      for (const f of files) {
        const chunks: Buffer[] = [];
        for await (const c of await storage.get(f.storage_key)) chunks.push(Buffer.from(c as Buffer));
        attachments.push({ filename: f.name, content: Buffer.concat(chunks) });
      }
      try {
        await config.mailer(b.to.join(", "), subject, `${b.body}\n\n-- \n${me!.name} via OpenBuild (${project.name})`, { cc: b.cc, replyTo: me!.email, attachments });
        status = "sent";
      } catch (e) {
        status = "failed";
        error = (e as Error).message.slice(0, 500);
      }
    }
    const row = await db.tx(async (q) => {
      const [e] = await q.query<{ id: string }>(
        `INSERT INTO project_emails (project_id, thread_number, direction, from_address, to_addresses, cc_addresses, subject, body, status, error, sent_by)
         VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [project.id, thread, me!.email, b.to, b.cc, subject, b.body, status, error, user.id]);
      for (const f of files) await q.query("INSERT INTO project_email_files (email_id, file_id) VALUES ($1, $2)", [e!.id, f.id]);
      await audit(q, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: `email.${status}`, entityType: "project", entityId: project.id, detail: { thread, to: b.to.length, files: files.length } });
      return e!;
    });
    return reply.code(201).send({ id: row.id, thread, status, error });
  });

  /** Turns inbound mail on (or rotates the secret). The URL is shown once; configure it as the provider's webhook. */
  app.post<{ Params: { projectId: string } }>("/projects/:projectId/emails/inbound-token", async (req) => {
    const user = requireUser(req);
    const { project } = await requireProject(db, user.id, req.params.projectId, "project.manage");
    const token = randomBytes(32).toString("base64url");
    await db.query("UPDATE projects SET inbound_email_token_hash = $2 WHERE id = $1", [project.id, sha256(token)]);
    await audit(db, { orgId: project.org_id, projectId: project.id, actorId: user.id, action: "email.inbound_token", entityType: "project", entityId: project.id });
    return { path: `/api/inbound-email/${token}` };
  });

  /**
   * Inbound webhook (no session: the URL's secret identifies the project). Accepts a simple JSON shape that mail
   * providers can be mapped to: { from, to?, cc?, subject, text }. A "[#E-n]" tag in the subject joins thread n.
   */
  app.post<{ Params: { token: string } }>("/inbound-email/:token", async (req, reply) => {
    const [p] = await db.query<{ id: string; org_id: string }>("SELECT id, org_id FROM projects WHERE inbound_email_token_hash = $1", [sha256(req.params.token)]);
    if (!p) throw new HttpError(404, "Not found");
    const b = z.object({ from: z.string().trim().max(320), to: z.array(z.string().max(320)).max(50).default([]), cc: z.array(z.string().max(320)).max(50).default([]), subject: z.string().trim().max(300).default("(no subject)"), text: z.string().max(100000).default("") }).parse(req.body);
    const m = TAG_RE.exec(b.subject);
    let thread = m ? Number(m[1]) : 0;
    if (!thread || !(await db.query("SELECT 1 FROM project_emails WHERE project_id = $1 AND thread_number = $2", [p.id, thread])).length) {
      thread = (await db.query<{ n: number }>("SELECT coalesce(max(thread_number), 0)::int + 1 AS n FROM project_emails WHERE project_id = $1", [p.id]))[0]!.n;
    }
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO project_emails (project_id, thread_number, direction, from_address, to_addresses, cc_addresses, subject, body, status)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, 'received')`,
        [p.id, thread, b.from, b.to, b.cc, b.subject || "(no subject)", b.text]);
      const managers = await q.query<{ user_id: string }>("SELECT user_id FROM project_memberships WHERE project_id = $1 AND role = 'manager'", [p.id]);
      await config.notify(q, managers.map((x) => x.user_id), { kind: "email", title: `Email from ${b.from}: ${b.subject}`, link: `/projects/${p.id}/emails`, projectId: p.id, actorId: null });
    });
    return reply.code(202).send({ thread });
  });
};
