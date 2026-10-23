import { createHash, createPublicKey, randomBytes, verify as verifySig, type JsonWebKey } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { type AppConfig, SESSION_DAYS, setSessionCookie } from "../app.js";
import { audit } from "../lib/audit.js";
import { HttpError } from "../lib/errors.js";
import { newToken, sha256 } from "../lib/security.js";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Button label, e.g. "Microsoft" or "Okta". */
  name: string;
  /** Public base URL of OpenBuild; the redirect URI is `${baseUrl}/api/auth/oidc/callback`. */
  baseUrl: string;
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * OpenID Connect sign-in (authorization code + PKCE). Only people who already have an OpenBuild account
 * (created by invitation) can sign in, matched on a verified email; SSO never creates accounts on its own.
 */
export const oidcRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const oidc = config.oidc;
  if (!oidc) return;
  const { db } = config;
  let discovery: Discovery | null = null;
  let jwks: { keys: (JsonWebKey & { kid?: string })[] } | null = null;

  async function disco(): Promise<Discovery> {
    if (!discovery) {
      const res = await fetch(`${oidc!.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
      if (!res.ok) throw new HttpError(502, "Identity provider unavailable");
      discovery = (await res.json()) as Discovery;
    }
    return discovery;
  }
  async function keyFor(kid: string | undefined, retry = true): Promise<JsonWebKey> {
    if (!jwks) jwks = (await (await fetch((await disco()).jwks_uri)).json()) as { keys: JsonWebKey[] };
    const k = jwks.keys.find((x) => !kid || x.kid === kid);
    if (!k && retry) { jwks = null; return keyFor(kid, false); } // key rotation
    if (!k) throw new HttpError(401, "Unknown signing key");
    return k;
  }

  app.get<{ Querystring: { returnTo?: string } }>("/auth/oidc/start", async (req, reply) => {
    const d = await disco();
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const returnTo = req.query.returnTo?.startsWith("/") && !req.query.returnTo.startsWith("//") ? req.query.returnTo : "/";
    await db.query("DELETE FROM oidc_states WHERE expires_at < now()");
    await db.query(`INSERT INTO oidc_states (state_hash, nonce, code_verifier, return_to, expires_at) VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`, [sha256(state), nonce, verifier, returnTo]);
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code", client_id: oidc.clientId, redirect_uri: `${oidc.baseUrl}/api/auth/oidc/callback`,
      scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/auth/oidc/callback", async (req, reply) => {
    const fail = (msg: string) => reply.redirect(`/?sso_error=${encodeURIComponent(msg)}`);
    if (req.query.error) return fail(`The identity provider refused sign-in (${req.query.error}).`);
    if (!req.query.code || !req.query.state) return fail("Sign-in response was incomplete.");
    const [st] = await db.query<{ nonce: string; code_verifier: string; return_to: string }>(
      "DELETE FROM oidc_states WHERE state_hash = $1 AND expires_at > now() RETURNING nonce, code_verifier, return_to",
      [sha256(req.query.state)],
    );
    if (!st) return fail("Sign-in expired. Please try again.");
    const d = await disco();
    const tokenRes = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: req.query.code, redirect_uri: `${oidc.baseUrl}/api/auth/oidc/callback`,
        client_id: oidc.clientId, code_verifier: st.code_verifier, ...(oidc.clientSecret ? { client_secret: oidc.clientSecret } : {}),
      }),
    });
    if (!tokenRes.ok) return fail("The identity provider rejected the sign-in code.");
    const { id_token } = (await tokenRes.json()) as { id_token?: string };
    if (!id_token) return fail("No ID token returned.");

    let claims: { iss: string; aud: string | string[]; exp: number; nonce?: string; email?: string; email_verified?: boolean; preferred_username?: string };
    try {
      const [h, p, s] = id_token.split(".");
      const header = JSON.parse(Buffer.from(h!, "base64url").toString()) as { alg: string; kid?: string };
      if (header.alg !== "RS256") throw new Error(`unsupported alg ${header.alg}`);
      const key = createPublicKey({ key: await keyFor(header.kid), format: "jwk" });
      if (!verifySig("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s!, "base64url"))) throw new Error("bad signature");
      claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    } catch {
      return fail("The sign-in token could not be verified.");
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== d.issuer || !aud.includes(oidc.clientId) || claims.exp * 1000 < Date.now() - 60_000 || claims.nonce !== st.nonce) {
      return fail("The sign-in token is not valid for OpenBuild.");
    }
    const email = (claims.email ?? "").toLowerCase();
    if (!email || claims.email_verified === false) return fail("Your identity provider did not share a verified email address.");
    const [u] = await db.query<{ id: string; disabled_at: string | null }>("SELECT id, disabled_at FROM users WHERE lower(email) = $1", [email]);
    if (!u || u.disabled_at) return fail(`No OpenBuild account for ${email}. Ask an administrator to invite you.`);

    const { token, hash } = newToken();
    await db.tx(async (q) => {
      await q.query(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`, [hash, u.id, SESSION_DAYS, `SSO (${oidc.name}) ${(req.headers["user-agent"] ?? "").slice(0, 250)}`]);
      await audit(q, { orgId: null, actorId: u.id, action: "user.sso_login", entityType: "user", entityId: u.id, detail: { provider: oidc.name } });
    });
    setSessionCookie(reply, token, config.secureCookies);
    return reply.redirect(st.return_to);
  });
};
