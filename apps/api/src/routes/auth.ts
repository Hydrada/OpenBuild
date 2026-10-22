import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { Queryable } from "../db/db.js";
import { type AppConfig, SESSION_COOKIE, SESSION_DAYS, requireUser, setSessionCookie } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { RateLimiter, hashPassword, newToken, sha256, verifyPassword } from "../lib/security.js";

const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const password = z.string().min(10, "Password must be at least 10 characters").max(200);
const name = z.string().trim().min(1).max(120);

export const authRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);

  async function startSession(q: Queryable, reply: FastifyReply, userId: string) {
    const { token, hash } = newToken();
    await q.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
      [hash, userId, SESSION_DAYS],
    );
    setSessionCookie(reply, token, config.secureCookies);
  }

  app.post("/auth/register", async (req, reply) => {
    if (!config.allowSignup) throw new HttpError(403, "Self-service signup is disabled on this server");
    const body = z.object({ email, password, name, orgName: name }).parse(req.body);
    const pwHash = await hashPassword(body.password);
    const user = await db.tx(async (q) => {
      const existing = await q.query("SELECT 1 FROM users WHERE lower(email) = $1", [body.email]);
      if (existing.length) throw new HttpError(409, "An account with that email already exists");
      const [u] = await q.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [body.email, body.name, pwHash],
      );
      const [org] = await q.query<{ id: string }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [body.orgName]);
      await q.query("INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org!.id, u!.id]);
      await audit(q, { orgId: org!.id, actorId: u!.id, action: "org.create", entityType: "organization", entityId: org!.id, detail: { name: body.orgName } });
      await startSession(q, reply, u!.id);
      return u!;
    });
    return reply.code(201).send({ id: user.id });
  });

  app.post("/auth/login", async (req, reply) => {
    const body = z.object({ email, password: z.string().max(200) }).parse(req.body);
    if (!loginLimiter.hit(`${req.ip}|${body.email}`)) throw new HttpError(429, "Too many sign-in attempts. Try again later.");
    const [u] = await db.query<{ id: string; password_hash: string; disabled_at: string | null }>(
      "SELECT id, password_hash, disabled_at FROM users WHERE lower(email) = $1",
      [body.email],
    );
    // Verify against a dummy hash when the user is unknown so timing does not reveal account existence.
    const ok = await verifyPassword(body.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || u.disabled_at) throw new HttpError(401, "Incorrect email or password");
    await startSession(db, reply, u.id);
    return { id: u.id };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req) => {
    const user = requireUser(req);
    const orgs = await db.query(
      `SELECT o.id, o.name, m.role FROM org_memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 ORDER BY o.created_at`,
      [user.id],
    );
    return { user, orgs, allowSignup: config.allowSignup };
  });

  app.get("/auth/config", async () => ({ allowSignup: config.allowSignup }));

  // ---- Invitations (accepting is part of auth: it may create the account) ----

  app.get<{ Params: { token: string } }>("/invitations/:token", async (req) => {
    const inv = await findInvitation(db, req.params.token);
    return { email: inv.email, orgName: inv.org_name, projectName: inv.project_name, accountExists: inv.user_exists };
  });

  app.post<{ Params: { token: string } }>("/invitations/:token/accept", async (req, reply) => {
    const inv = await findInvitation(db, req.params.token);
    let existingUserId: string | null = null;
    let newUser: { name: string; pwHash: string } | null = null;
    if (inv.user_exists) {
      // Existing account: must already be signed in as the invited address.
      const user = requireUser(req);
      if (user.email.toLowerCase() !== inv.email.toLowerCase()) throw new HttpError(403, "This invitation is for a different account");
      existingUserId = user.id;
    } else {
      const body = z.object({ name, password }).parse(req.body);
      newUser = { name: body.name, pwHash: await hashPassword(body.password) };
    }
    await db.tx(async (q) => {
      let userId = existingUserId;
      if (newUser) {
        const [u] = await q.query<{ id: string }>(
          "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
          [inv.email, newUser.name, newUser.pwHash],
        );
        userId = u!.id;
      }
      if (!userId) throw new HttpError(500, "Unreachable");
      const claimed = await q.query(
        "UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL RETURNING id",
        [inv.id],
      );
      if (!claimed.length) throw new HttpError(410, "This invitation has already been used");
      await q.query(
        `INSERT INTO org_memberships (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING`,
        [inv.org_id, userId, inv.org_role],
      );
      if (inv.project_id && inv.project_role) {
        await q.query(
          `INSERT INTO project_memberships (project_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [inv.project_id, userId, inv.project_role],
        );
      }
      await audit(q, { orgId: inv.org_id, projectId: inv.project_id, actorId: userId, action: "invitation.accept", entityType: "invitation", entityId: inv.id, detail: { email: inv.email } });
      if (!req.user) await startSession(q, reply, userId);
    });
    return { ok: true, orgId: inv.org_id, projectId: inv.project_id };
  });
};

async function findInvitation(db: Queryable, token: string) {
  const [inv] = await db.query<{
    id: string; org_id: string; email: string; org_role: string; project_id: string | null; project_role: string | null;
    org_name: string; project_name: string | null; user_exists: boolean; accepted_at: string | null; expired: boolean;
  }>(
    `SELECT i.id, i.org_id, i.email, i.org_role, i.project_id, i.project_role, i.accepted_at,
            o.name AS org_name, p.name AS project_name, i.expires_at < now() AS expired,
            EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email)) AS user_exists
       FROM invitations i JOIN organizations o ON o.id = i.org_id LEFT JOIN projects p ON p.id = i.project_id
      WHERE i.token_hash = $1`,
    [sha256(token)],
  );
  if (!inv) throw new HttpError(404, "Invitation not found");
  if (inv.accepted_at) throw new HttpError(410, "This invitation has already been used");
  if (inv.expired) throw new HttpError(410, "This invitation has expired");
  return inv;
}

// scrypt hash of a random throwaway password; only used to equalize login timing.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");
