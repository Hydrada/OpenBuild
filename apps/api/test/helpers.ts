import { buildApp } from "../src/app.js";
import { createPgliteDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function makeApp(opts: { dataDir?: string; allowSignup?: boolean } = {}) {
  const db = await createPgliteDb(opts.dataDir);
  await migrate(db);
  const app = await buildApp({ db, allowSignup: opts.allowSignup ?? true, secureCookies: false });
  return { app, db };
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
