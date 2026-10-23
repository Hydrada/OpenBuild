import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { existsSync } from "node:fs";
import { ZodError } from "zod";
import type { Db } from "./db/db.js";
import { requestScope } from "./lib/context.js";
import { toolForRoute } from "./lib/tools.js";
import { HttpError } from "./lib/errors.js";
import { sha256 } from "./lib/security.js";
import type { Mailer, Notifier } from "./lib/notify.js";
import type { OidcConfig } from "./routes/oidc.js";
import { oidcRoutes } from "./routes/oidc.js";
import type { SamlConfig } from "./routes/saml.js";
import { samlRoutes } from "./routes/saml.js";
import type { Storage } from "./lib/storage.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { biddingRoutes } from "./routes/bidding.js";
import { projectToolRoutes } from "./routes/project-tools.js";
import { closeoutRoutes } from "./routes/closeout.js";
import { searchRoutes } from "./routes/search.js";
import { crewRoutes } from "./routes/crews.js";
import { reportRoutes } from "./routes/reports.js";
import { pdfRoutes } from "./routes/pdf.js";
import { annotationRoutes } from "./routes/annotations.js";
import { subcontractRoutes } from "./routes/subcontract.js";
import { drawingSetRoutes } from "./routes/drawing-sets.js";
import { photoRoutes } from "./routes/photos.js";
import { permissionTemplateRoutes } from "./routes/permission-templates.js";
import { formRoutes } from "./routes/forms.js";
import { estimateRoutes } from "./routes/estimates.js";
import { bimRoutes } from "./routes/bim.js";
import { collabRoutes } from "./routes/collab.js";
import { documentRoutes } from "./routes/documents.js";
import { fieldRoutes } from "./routes/field.js";
import { financialRoutes } from "./routes/financials.js";
import { meetingRoutes } from "./routes/meetings.js";
import { rfiRoutes } from "./routes/rfis.js";
import { scheduleRoutes } from "./routes/schedule.js";
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
  /** When set, invitations and reset links are also emailed. */
  mailer?: Mailer;
  /** Public URL of this server (e.g. https://build.example.com), used in emailed links. */
  baseUrl?: string;
  /** Optional OpenID Connect single sign-on. */
  oidc?: OidcConfig;
  /** Optional SAML 2.0 single sign-on. */
  saml?: SamlConfig;
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
  interface FastifyInstance {
    routeList: { method: string; url: string }[];
  }
  interface FastifyRequest {
    user: SessionUser | null;
    apiKeyOrgId: string | null;
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

  // Route inventory (used by the security sweep tests and docs/API.md generation).
  const routeList: { method: string; url: string }[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") routeList.push({ method: m, url: r.url });
  });
  app.decorate("routeList", routeList);

  app.decorateRequest("user", null);
  app.decorateRequest("apiKeyOrgId", null);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const bearer = /^Bearer (ob_[\w-]+)$/.exec(req.headers.authorization ?? "")?.[1];
    // Cookie-authenticated writes must prove same-origin script (CSRF). API keys and tool links carry no cookie.
    const tokenAuthenticated = !!bearer || req.url.startsWith("/api/tool/") || req.url.startsWith("/api/bids/") || req.url.startsWith("/api/auth/saml/acs");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.headers[CSRF_HEADER] && !tokenAuthenticated) {
      return reply.code(403).send({ error: "Missing CSRF header" });
    }
    if (bearer) {
      const [k] = await config.db.query<SessionUser & { key_id: string; org_id: string }>(
        `SELECT u.id, u.email, u.name, k.id AS key_id, k.org_id FROM api_keys k JOIN users u ON u.id = k.user_id
          WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND u.disabled_at IS NULL
            AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = k.org_id AND m.user_id = k.user_id AND m.role IN ('owner','admin'))`,
        [sha256(bearer)],
      );
      if (!k) return reply.code(401).send({ error: "Invalid API key" });
      await config.db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [k.key_id]);
      req.user = { id: k.id, email: k.email, name: k.name };
      req.apiKeyOrgId = k.org_id;
      return;
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
  // Run the rest of the request inside its permission scope (callback style so the handler inherits it).
  app.addHook("onRequest", (req, _reply, done) => {
    requestScope.run({ apiKeyOrgId: req.apiKeyOrgId ?? undefined, tool: toolForRoute(req.routeOptions?.url) }, done);
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
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
  await app.register(collabRoutes(config), { prefix: "/api" });
  await app.register(scheduleRoutes(config), { prefix: "/api" });
  await app.register(meetingRoutes(config), { prefix: "/api" });
  await app.register(biddingRoutes(config), { prefix: "/api" });
  await app.register(bimRoutes(config), { prefix: "/api" });
  await app.register(projectToolRoutes(config), { prefix: "/api" });
  await app.register(closeoutRoutes(config), { prefix: "/api" });
  await app.register(searchRoutes(config), { prefix: "/api" });
  await app.register(crewRoutes(config), { prefix: "/api" });
  await app.register(reportRoutes(config), { prefix: "/api" });
  await app.register(pdfRoutes(config), { prefix: "/api" });
  await app.register(annotationRoutes(config), { prefix: "/api" });
  await app.register(subcontractRoutes(config), { prefix: "/api" });
  await app.register(drawingSetRoutes(config), { prefix: "/api" });
  await app.register(photoRoutes(config), { prefix: "/api" });
  await app.register(permissionTemplateRoutes(config), { prefix: "/api" });
  await app.register(formRoutes(config), { prefix: "/api" });
  await app.register(estimateRoutes(config), { prefix: "/api" });
  await app.register(oidcRoutes(config), { prefix: "/api" });
  await app.register(samlRoutes(config), { prefix: "/api" });

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
