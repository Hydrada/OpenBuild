import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, SESSION_COOKIE, requireUser } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { isUuid, requireOrgRole } from "../lib/permissions.js";
import { hashPassword, newToken, sha256, verifyPassword } from "../lib/security.js";

const password = z.string().min(10, "Password must be at least 10 characters").max(200);

/** Password changes/resets, session management, member removal, and in-app notifications. */
export const accountRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  app.post("/me/password", async (req) => {
    const user = requireUser(req);
    const b = z.object({ currentPassword: z.string().max(200), newPassword: password }).parse(req.body);
    const [u] = await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
    if (!(await verifyPassword(b.currentPassword, u!.password_hash))) throw new HttpError(400, "Current password is incorrect");
    const hash = await hashPassword(b.newPassword);
    const current = sha256(req.cookies[SESSION_COOKIE] ?? "");
    await db.tx(async (q) => {
      await q.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, hash]);
      // Keep this session, sign out every other device.
      await q.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, current]);
      await audit(q, { orgId: null, actorId: user.id, action: "user.password_change", entityType: "user", entityId: user.id });
    });
    return { ok: true };
  });

  app.get("/me/sessions", async (req) => {
    const user = requireUser(req);
    const current = sha256(req.cookies[SESSION_COOKIE] ?? "");
    return db.query(
      `SELECT id, created_at, expires_at, user_agent, token_hash = $2 AS current FROM sessions
        WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC`,
      [user.id, current],
    );
  });

  app.delete<{ Params: { id: string } }>("/me/sessions/:id", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, "Session not found");
    const r = await db.query("DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id", [req.params.id, user.id]);
    if (!r.length) throw new HttpError(404, "Session not found");
    return { ok: true };
  });

  app.post("/auth/logout-all", async (req, reply) => {
    const user = requireUser(req);
    await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  /**
   * Admin-issued reset link (works without email). Owners can reset anyone; admins can reset members only.
   * The link is valid for 24 hours and single-use.
   */
  app.post<{ Params: { orgId: string; userId: string } }>("/orgs/:orgId/members/:userId/reset-link", async (req, reply) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId) || !isUuid(req.params.userId)) throw new HttpError(404, "Member not found");
    const myRole = await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    const [target] = await db.query<{ role: string }>("SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2", [req.params.orgId, req.params.userId]);
    if (!target) throw new HttpError(404, "Member not found");
    if (myRole === "admin" && target.role !== "member") throw new HttpError(403, "Admins can only reset members' passwords");
    // A user who belongs to another org where the requester has no authority could be hijacked via a reset link.
    const [foreign] = await db.query(
      `SELECT 1 FROM org_memberships m WHERE m.user_id = $1 AND m.org_id <> $2
          AND NOT EXISTS (SELECT 1 FROM org_memberships me WHERE me.user_id = $3 AND me.org_id = m.org_id AND me.role = 'owner')`,
      [req.params.userId, req.params.orgId, user.id],
    );
    if (foreign) throw new HttpError(403, "This person also belongs to another organization; they must reset their own password");
    const { token, hash } = newToken();
    await db.tx(async (q) => {
      await q.query(`INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES ($1, $2, $3, now() + interval '24 hours')`, [hash, req.params.userId, user.id]);
      await audit(q, { orgId: req.params.orgId, actorId: user.id, action: "user.reset_link", entityType: "user", entityId: req.params.userId });
    });
    const resetPath = `/reset/${token}`;
    let emailSent = false;
    if (config.mailer && config.baseUrl) {
      const [u] = await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [req.params.userId]);
      emailSent = await config.mailer(u!.email, "Reset your OpenBuild password", `Set a new password within 24 hours: ${config.baseUrl}${resetPath}`).then(() => true, () => false);
    }
    return reply.code(201).send({ resetPath, emailSent });
  });

  app.get<{ Params: { token: string } }>("/password-resets/:token", async (req) => {
    const r = await findReset(req.params.token);
    return { email: r.email };
  });

  app.post<{ Params: { token: string } }>("/password-resets/:token", async (req) => {
    const r = await findReset(req.params.token);
    const b = z.object({ password }).parse(req.body);
    const hash = await hashPassword(b.password);
    await db.tx(async (q) => {
      const claimed = await q.query("UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL RETURNING 1", [sha256(req.params.token)]);
      if (!claimed.length) throw new HttpError(410, "This link has already been used");
      await q.query("UPDATE users SET password_hash = $2 WHERE id = $1", [r.user_id, hash]);
      await q.query("DELETE FROM sessions WHERE user_id = $1", [r.user_id]);
      await audit(q, { orgId: null, actorId: r.user_id, action: "user.password_reset", entityType: "user", entityId: r.user_id });
    });
    return { ok: true };
  });

  async function findReset(token: string) {
    const [r] = await db.query<{ user_id: string; email: string; used_at: string | null; expired: boolean }>(
      `SELECT pr.user_id, u.email, pr.used_at, pr.expires_at < now() AS expired FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = $1`,
      [sha256(token)],
    );
    if (!r) throw new HttpError(404, "Reset link not found");
    if (r.used_at) throw new HttpError(410, "This link has already been used");
    if (r.expired) throw new HttpError(410, "This link has expired");
    return r;
  }

  /** Removes a person from the organization (and all its projects). Their account and history remain. */
  app.delete<{ Params: { orgId: string; userId: string } }>("/orgs/:orgId/members/:userId", async (req) => {
    const user = requireUser(req);
    if (!isUuid(req.params.orgId) || !isUuid(req.params.userId)) throw new HttpError(404, "Member not found");
    const myRole = await requireOrgRole(db, user.id, req.params.orgId, ["owner", "admin"]);
    if (req.params.userId === user.id) throw new HttpError(400, "You cannot remove yourself");
    return db.tx(async (q) => {
      const [target] = await q.query<{ role: string }>("SELECT role FROM org_memberships WHERE org_id = $1 AND user_id = $2", [req.params.orgId, req.params.userId]);
      if (!target) throw new HttpError(404, "Member not found");
      if (target.role === "owner") throw new HttpError(403, "The owner cannot be removed");
      if (myRole === "admin" && target.role === "admin") throw new HttpError(403, "Only the owner can remove an admin");
      await q.query(`DELETE FROM project_memberships WHERE user_id = $2 AND project_id IN (SELECT id FROM projects WHERE org_id = $1)`, [req.params.orgId, req.params.userId]);
      await q.query("DELETE FROM org_memberships WHERE org_id = $1 AND user_id = $2", [req.params.orgId, req.params.userId]);
      await audit(q, { orgId: req.params.orgId, actorId: user.id, action: "member.remove", entityType: "user", entityId: req.params.userId, detail: { role: target.role } });
      return { ok: true };
    });
  });

  // ---------- Notifications ----------

  app.get<{ Querystring: { unread?: string } }>("/me/notifications", async (req) => {
    const user = requireUser(req);
    const items = await db.query(
      `SELECT n.id, n.kind, n.title, n.link, n.created_at, n.read_at, n.project_id, p.name AS project_name, a.name AS actor_name
         FROM notifications n LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN users a ON a.id = n.actor_id
        WHERE n.user_id = $1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
        ORDER BY n.created_at DESC LIMIT 100`,
      [user.id, req.query.unread === "1"],
    );
    const [c] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [user.id]);
    return { unread: c!.n, items };
  });

  app.post("/me/notifications/read", async (req) => {
    const user = requireUser(req);
    const b = z.object({ ids: z.array(z.uuid()).max(500).optional() }).parse(req.body);
    if (b.ids) await db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL", [user.id, b.ids]);
    else await db.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [user.id]);
    return { ok: true };
  });
};
