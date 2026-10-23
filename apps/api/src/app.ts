import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import type { Db } from "./db/db.js";
import { HttpError } from "./lib/errors.js";
import { sha256 } from "./lib/security.js";
import type { Notifier } from "./lib/notify.js";
import type { Storage } from "./lib/storage.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { documentRoutes } from "./routes/documents.js";
import { fieldRoutes } from "./routes/field.js";
import { financialRoutes } from "./routes/financials.js";
import { rfiRoutes } from "./routes/rfis.js";
import { orgRoutes } from "./routes/orgs.js";
import { projectRoutes } from "./routes/projects.js";

export interface AppConfig {
  db: Db;
  /** Allow anyone to register a new organization. Disable after first-run setup in shared deployments. */
  allowSignup: boolean;
  secureCookies: boolean;
  storage: Storage;
  notify: Notifier;
  /** External document tools (OpenDraft, the Acrobat alternative, ...). See docs/INTEGRATIONS.md. */
  documentTools: DocumentTool[];
  maxUploadBytes?: number;
  /** Absolute path to the built web client, served at / when present. */
  webDist?: string;
  logger?: boolean;
}

export interface DocumentTool {
  id: string;
  name: string;
  /** Optional deep link; `{downloadUrl}` and `{name}` are substituted. Without it the UI offers download + upload-markup. */
  urlTemplate?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = "ob_session";
export const SESSION_DAYS = 14;
/** Any value; its presence proves the request came from script on our origin (CSRF guard). */
export const CSRF_HEADER = "x-openbuild-csrf";

export async function buildApp(config: AppConfig) {
  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes ?? 100 * 1024 * 1024, files: 1, fields: 30 } });

  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.headers[CSRF_HEADER]) {
      return reply.code(403).send({ error: "Missing CSRF header" });
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const rows = await config.db.query<SessionUser>(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
      [sha256(token)],
    );
    req.user = rows[0] ?? null;
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid input", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/api/health", async () => {
    await config.db.query("SELECT 1");
    return { ok: true, driver: config.db.driver };
  });

  await app.register(authRoutes(config), { prefix: "/api" });
  await app.register(orgRoutes(config), { prefix: "/api" });
  await app.register(projectRoutes(config), { prefix: "/api" });
  await app.register(accountRoutes(config), { prefix: "/api" });
  await app.register(documentRoutes(config), { prefix: "/api" });
  await app.register(rfiRoutes(config), { prefix: "/api" });
  await app.register(fieldRoutes(config), { prefix: "/api" });
  await app.register(financialRoutes(config), { prefix: "/api" });

  if (config.webDist && existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    // Client-side routing: unknown non-API GETs get the SPA shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  return app;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, "Sign in required");
  return req.user;
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}
