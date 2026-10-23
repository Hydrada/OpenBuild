import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createNotifier } from "../src/lib/notify.js";
import { LocalStorage } from "../src/lib/storage.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, registerOwner, type App } from "./helpers.js";

/** Mock identity provider: discovery, JWKS and a token endpoint that enforces PKCE. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: attackerKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
let idp: Server;
let issuer: string;
const pending = new Map<string, { challenge: string; nonce: string; email: string; aud?: string; key?: typeof privateKey }>();

function jwt(claims: object, key = privateKey) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

beforeAll(async () => {
  idp = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (o: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (url.pathname === "/.well-known/openid-configuration") return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url.pathname === "/jwks") return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] });
    if (url.pathname === "/token") {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        const f = new URLSearchParams(body);
        const p = pending.get(f.get("code")!);
        if (!p || createHash("sha256").update(f.get("code_verifier")!).digest("base64url") !== p.challenge) return json({ error: "invalid_grant" }, 400);
        json({ id_token: jwt({ iss: issuer, aud: p.aud ?? "openbuild", exp: Math.floor(Date.now() / 1000) + 300, nonce: p.nonce, email: p.email, email_verified: true }, p.key ?? privateKey) });
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => idp.close(() => r())));

async function ssoApp(): Promise<{ app: App; db: Db }> {
  const db = await createPgliteDb();
  await migrate(db);
  const app = await buildApp({
    db, storage: new LocalStorage(mkdtempSync(join(tmpdir(), "ob-sso-"))), allowSignup: true, secureCookies: false, notify: createNotifier(), documentTools: [],
    baseUrl: "http://openbuild.test", oidc: { issuer, clientId: "openbuild", clientSecret: "s3cret", name: "Okta", baseUrl: "http://openbuild.test" },
  });
  return { app, db };
}

/** Runs start → (IdP) → callback, returning the callback response. */
async function signIn(app: App, email: string, tamper: { aud?: string; key?: typeof privateKey; replay?: boolean; returnTo?: string } = {}) {
  const start = await app.inject({ method: "GET", url: `/api/auth/oidc/start${tamper.returnTo ? `?returnTo=${encodeURIComponent(tamper.returnTo)}` : ""}` });
  const loc = new URL(start.headers.location as string);
  expect(loc.origin).toBe(issuer);
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  const code = `code-${Math.random()}`;
  pending.set(code, { challenge: loc.searchParams.get("code_challenge")!, nonce: loc.searchParams.get("nonce")!, email, aud: tamper.aud, key: tamper.key });
  const state = loc.searchParams.get("state")!;
  const cb = await app.inject({ method: "GET", url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${state}` });
  if (tamper.replay) return app.inject({ method: "GET", url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${state}` });
  return cb;
}

describe("OpenID Connect single sign-on", () => {
  it("signs in an invited user and rejects forged, misdirected, replayed and uninvited sign-ins", async () => {
    const { app, db } = await ssoApp();
    try {
      await registerOwner(app, "pat@acme.test");
      expect((await new Client(app).get("/api/auth/config")).body.sso).toEqual({ name: "Okta" });

      const ok = await signIn(app, "PAT@acme.test", { returnTo: "/projects" });
      expect(ok.statusCode).toBe(302);
      expect(ok.headers.location).toBe("/projects");
      const cookie = ok.cookies.find((c) => c.name === "ob_session")!;
      const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `ob_session=${cookie.value}` } });
      expect(me.json().user.email).toBe("pat@acme.test");

      const bad = async (r: Awaited<ReturnType<typeof signIn>>, re: RegExp) => {
        expect(r.statusCode).toBe(302);
        expect(decodeURIComponent(String(r.headers.location))).toMatch(re);
        expect(r.cookies.find((c) => c.name === "ob_session")).toBeUndefined();
      };
      await bad(await signIn(app, "pat@acme.test", { key: attackerKey }), /could not be verified/);
      await bad(await signIn(app, "pat@acme.test", { aud: "someone-else" }), /not valid for OpenBuild/);
      await bad(await signIn(app, "pat@acme.test", { replay: true }), /expired/);
      await bad(await signIn(app, "stranger@acme.test"), /No OpenBuild account/);
      const open = await signIn(app, "pat@acme.test", { returnTo: "//evil.example" });
      expect(open.headers.location).toBe("/"); // no open redirect
      const audit = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.sso_login'");
      expect(audit[0]!.n).toBe(3); // main, first leg of the replay test, open-redirect test
    } finally {
      await app.close();
      await db.close();
    }
  });
});
