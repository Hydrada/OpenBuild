import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createDb, defaultDataPath } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { createSmtpMailer } from "./lib/mailer.js";
import { createNotifier } from "./lib/notify.js";
import { storageFromEnv } from "./lib/storage.js";

const env = process.env;
const db = await createDb(env);
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

const mailer = env.OPENBUILD_SMTP_URL ? createSmtpMailer(env.OPENBUILD_SMTP_URL, env.OPENBUILD_MAIL_FROM ?? "OpenBuild <no-reply@localhost>") : undefined;
const baseUrl = env.OPENBUILD_BASE_URL?.replace(/\/$/, "");

const app = await buildApp({
  db,
  allowSignup: env.OPENBUILD_ALLOW_SIGNUP !== "false",
  secureCookies: env.OPENBUILD_SECURE_COOKIES === "true",
  storage: storageFromEnv(env, env.OPENBUILD_STORAGE_DIR || defaultDataPath("files")),
  notify: createNotifier({ baseUrl, mailer }),
  mailer,
  baseUrl,
  oidc: env.OPENBUILD_OIDC_ISSUER && env.OPENBUILD_OIDC_CLIENT_ID && baseUrl
    ? { issuer: env.OPENBUILD_OIDC_ISSUER, clientId: env.OPENBUILD_OIDC_CLIENT_ID, clientSecret: env.OPENBUILD_OIDC_CLIENT_SECRET, name: env.OPENBUILD_OIDC_NAME ?? "SSO", baseUrl }
    : undefined,
  documentTools: env.OPENBUILD_DOC_TOOLS ? JSON.parse(env.OPENBUILD_DOC_TOOLS) : [{ id: "opendraft", name: "OpenDraft" }],
  webDist: env.OPENBUILD_WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  logger: env.NODE_ENV !== "test",
});

const port = Number(env.PORT ?? 3000);
await app.listen({ port, host: env.HOST ?? "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
