import type { FastifyPluginAsync } from "fastify";
import { type AppConfig, SESSION_DAYS, setSessionCookie } from "../app.js";
import { audit } from "../lib/audit.js";
import { newToken } from "../lib/security.js";

export interface SamlConfig {
  /** Identity provider single sign-on URL (HTTP-Redirect binding). */
  entryPoint: string;
  /** IdP signing certificate (PEM or base64 body). */
  idpCert: string;
  /** Button label, e.g. "Microsoft" or "Okta". */
  name: string;
  /** Public base URL of OpenBuild; the SP entity ID and ACS URL derive from it. */
  baseUrl: string;
}

/**
 * SAML 2.0 single sign-on (SP-initiated, HTTP-Redirect request, HTTP-POST response). Assertions must be signed by the
 * configured IdP certificate, addressed to this SP and within their validity window. Like OIDC, SAML never creates
 * accounts: the asserted email must belong to an invited OpenBuild user.
 */
export const samlRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const saml = config.saml;
  if (!saml) return;
  const { db } = config;
  const { SAML, ValidateInResponseTo } = await import("@node-saml/node-saml");
  const entityId = `${saml.baseUrl}/api/auth/saml/metadata`;
  const sp = new SAML({
    entryPoint: saml.entryPoint,
    issuer: entityId,
    callbackUrl: `${saml.baseUrl}/api/auth/saml/acs`,
    idpCert: saml.idpCert,
    audience: entityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.ifPresent,
    acceptedClockSkewMs: 60_000,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  });
  // Replay protection: each assertion ID is accepted once while it is valid.
  const seen = new Map<string, number>();

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/auth/saml/metadata", async (_req, reply) => {
    reply.header("Content-Type", "application/samlmetadata+xml");
    return sp.generateServiceProviderMetadata(null);
  });

  app.get<{ Querystring: { returnTo?: string } }>("/auth/saml/start", async (req, reply) => {
    const returnTo = req.query.returnTo?.startsWith("/") && !req.query.returnTo.startsWith("//") ? req.query.returnTo : "/";
    return reply.redirect(await sp.getAuthorizeUrlAsync(returnTo, undefined, {}));
  });

  app.post<{ Body: { SAMLResponse?: string; RelayState?: string } }>("/auth/saml/acs", async (req, reply) => {
    const fail = (msg: string) => reply.redirect(`/?sso_error=${encodeURIComponent(msg)}`);
    if (!req.body?.SAMLResponse) return fail("Sign-in response was incomplete.");
    let profile: Record<string, unknown> | null;
    try {
      ({ profile } = await sp.validatePostResponseAsync({ SAMLResponse: req.body.SAMLResponse }));
    } catch {
      return fail("The sign-in response could not be verified.");
    }
    if (!profile) return fail("The sign-in response could not be verified.");
    const assertionId = String((profile as { ID?: string }).ID ?? (profile as { sessionIndex?: string }).sessionIndex ?? "");
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (assertionId && seen.has(assertionId)) return fail("This sign-in response was already used.");
    if (assertionId) seen.set(assertionId, now + 10 * 60_000);

    const email = String((profile as { email?: string }).email ?? (profile as { mail?: string }).mail ?? (profile as { nameID?: string }).nameID ?? "").toLowerCase();
    if (!email.includes("@")) return fail("Your identity provider did not share an email address.");
    const [u] = await db.query<{ id: string; disabled_at: string | null }>("SELECT id, disabled_at FROM users WHERE lower(email) = $1", [email]);
    if (!u || u.disabled_at) return fail(`No OpenBuild account for ${email}. Ask an administrator to invite you.`);
    const { token, hash } = newToken();
    await db.tx(async (q) => {
      await q.query(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`, [hash, u.id, SESSION_DAYS, `SSO SAML (${saml.name}) ${(req.headers["user-agent"] ?? "").slice(0, 250)}`]);
      await audit(q, { orgId: null, actorId: u.id, action: "user.sso_login", entityType: "user", entityId: u.id, detail: { provider: saml.name, protocol: "saml" } });
    });
    setSessionCookie(reply, token, config.secureCookies);
    const relay = req.body.RelayState;
    return reply.redirect(relay?.startsWith("/") && !relay.startsWith("//") ? relay : "/");
  });
};
