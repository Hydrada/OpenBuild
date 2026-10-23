import { buildApp, type DocumentTool } from "../src/app.js";
import type { Mailer } from "../src/lib/notify.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createPgliteDb, createPostgresDb, type Db } from "../src/db/db.js";
import { createNotifier } from "../src/lib/notify.js";
import { LocalStorage } from "../src/lib/storage.js";
import { migrate } from "../src/db/migrate.js";

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function makeApp(opts: { dataDir?: string; storageDir?: string; allowSignup?: boolean; mailer?: Mailer; documentTools?: DocumentTool[] } = {}) {
  const db = opts.dataDir || !process.env.TEST_DATABASE_URL ? await createPgliteDb(opts.dataDir) : await freshPostgresSchema(process.env.TEST_DATABASE_URL);
  await migrate(db);
  const storage = new LocalStorage(opts.storageDir ?? mkdtempSync(join(tmpdir(), "openbuild-files-")));
  const app = await buildApp({
    db, storage, allowSignup: opts.allowSignup ?? true, secureCookies: false,
    notify: createNotifier({ mailer: opts.mailer, baseUrl: "http://openbuild.test" }), mailer: opts.mailer, baseUrl: "http://openbuild.test",
    documentTools: opts.documentTools ?? [{ id: "opendraft", name: "OpenDraft" }],
  });
  return { app, db, storage };
}

/** With TEST_DATABASE_URL set (CI), each app gets its own schema in a real PostgreSQL server. */
async function freshPostgresSchema(url: string): Promise<Db> {
  const schema = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  return createPostgresDb(url, schema);
}

/** A cookie-carrying client, like a browser tab. */
export class Client {
  cookie = "";
  constructor(private app: App) {}

  async req(method: string, url: string, body?: unknown) {
    const res = await this.app.inject({
      method: method as "GET",
      url,
      payload: body as object,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(method !== "GET" ? { "x-openbuild-csrf": "1" } : {}),
      },
    });
    const set = res.cookies.find((c) => c.name === "ob_session");
    if (set) this.cookie = set.value ? `ob_session=${set.value}` : "";
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  }
  /** multipart/form-data POST with text fields and an optional single file. */
  async upload(url: string, fields: Record<string, string>, file?: { name: string; type: string; data: Buffer | string }, extraHeaders: Record<string, string> = {}) {
    const boundary = "----openbuildtest" + Math.random().toString(16).slice(2);
    const CRLF = String.fromCharCode(13, 10);
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`));
    }
    if (file) {
      parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${file.name}"${CRLF}Content-Type: ${file.type}${CRLF}${CRLF}`));
      parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
      parts.push(Buffer.from(CRLF));
    }
    parts.push(Buffer.from(`--${boundary}--${CRLF}`));
    const res = await this.app.inject({
      method: "POST", url, payload: Buffer.concat(parts),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-openbuild-csrf": "1", ...(this.cookie ? { cookie: this.cookie } : {}), ...extraHeaders },
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  }
  async raw(url: string, headers: Record<string, string> = {}) {
    return this.app.inject({ method: "GET", url, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers } });
  }
  del = (url: string) => this.req("DELETE", url);
  get = (url: string) => this.req("GET", url);
  post = (url: string, body?: unknown) => this.req("POST", url, body ?? {});
  patch = (url: string, body: unknown) => this.req("PATCH", url, body);
  put = (url: string, body: unknown) => this.req("PUT", url, body);
}

export async function registerOwner(app: App, email = "owner@example.com") {
  const c = new Client(app);
  const r = await c.post("/api/auth/register", { email, password: "correct horse battery", name: "Olive Owner", orgName: "Acme Builders" });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  const me = await c.get("/api/me");
  return { client: c, orgId: me.body.orgs[0].id as string, userId: me.body.user.id as string };
}

/** Invite `email` and accept as a brand-new user; returns their client. */
export async function inviteAndJoin(app: App, inviter: Client, orgId: string, email: string, extra: Record<string, unknown> = {}) {
  const inv = await inviter.post(`/api/orgs/${orgId}/invitations`, { email, ...extra });
  if (inv.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const token = (inv.body.acceptPath as string).split("/").pop()!;
  const c = new Client(app);
  const acc = await c.post(`/api/invitations/${token}/accept`, { name: email.split("@")[0], password: "another long password" });
  if (acc.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acc.body)}`);
  const me = await c.get("/api/me");
  return { client: c, userId: me.body.user.id as string, token };
}

export type { Db };

export const PDF = (label = "sheet") => Buffer.from(`%PDF-1.4
% ${label}
1 0 obj<<>>endobj
trailer<<>>
%%EOF
`);
