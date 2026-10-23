import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignedXml } from "xml-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createPgliteDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { createNotifier } from "../src/lib/notify.js";
import { LocalStorage } from "../src/lib/storage.js";
import { registerOwner, type App } from "./helpers.js";

// Test-only key pairs generated with openssl (fixtures/, never used outside tests).
const fx = (f: string) => readFileSync(join(import.meta.dirname, "fixtures", f), "utf8");
const IDP_KEY = fx("saml-idp-test.key");
const IDP_CERT = fx("saml-idp-test.crt");
const ATTACKER_KEY = fx("saml-attacker.key");
const BASE = "http://openbuild.test";
const SP = `${BASE}/api/auth/saml/metadata`;
const ACS = `${BASE}/api/auth/saml/acs`;

/** Builds a SAML Response whose Assertion is signed (enveloped, exclusive c14n, RSA-SHA256). */
function samlResponse(email: string, opts: { key?: string; audience?: string; notOnOrAfter?: Date; tamper?: boolean } = {}) {
  const now = new Date();
  const later = opts.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const aid = `_${randomUUID()}`;
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${now.toISOString()}"><saml:Issuer>https://idp.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later.toISOString()}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${opts.audience ?? SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${aid}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
  const sig = new SignedXml({ privateKey: opts.key ?? IDP_KEY, signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Issuer']", action: "after" } });
  let signed = sig.getSignedXml();
  if (opts.tamper) signed = signed.replace(email, "admin@acme.test");
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_${randomUUID()}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${ACS}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(response).toString("base64");
}

let app: App;
let db: Db;
beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  app = await buildApp({
    db, storage: new LocalStorage(mkdtempSync(join(tmpdir(), "ob-saml-"))), allowSignup: true, secureCookies: false, notify: createNotifier(), documentTools: [],
    baseUrl: BASE, saml: { entryPoint: "https://idp.test/sso", idpCert: IDP_CERT, name: "Entra ID", baseUrl: BASE },
  });
  await registerOwner(app, "pat@acme.test");
  await registerOwner(app, "admin@acme.test");
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const post = (SAMLResponse: string, RelayState = "/projects") =>
  app.inject({ method: "POST", url: "/api/auth/saml/acs", payload: new URLSearchParams({ SAMLResponse, RelayState }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const rejected = (r: Awaited<ReturnType<typeof post>>, re: RegExp) => {
  expect(r.statusCode).toBe(302);
  expect(decodeURIComponent(String(r.headers.location))).toMatch(re);
  expect(r.cookies.find((c) => c.name === "ob_session")).toBeUndefined();
};

describe("SAML 2.0 single sign-on", () => {
  it("publishes SP metadata and redirects to the IdP", async () => {
    const meta = await app.inject({ method: "GET", url: "/api/auth/saml/metadata" });
    expect(meta.body).toContain(`entityID="${SP}"`);
    expect(meta.body).toContain(ACS);
    const start = await app.inject({ method: "GET", url: "/api/auth/saml/start?returnTo=/projects" });
    expect(String(start.headers.location)).toMatch(/^https:\/\/idp\.test\/sso\?SAMLRequest=/);
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json().sso).toEqual({ name: "Entra ID", path: "/api/auth/saml/start" });
  });

  it("signs in an invited user from a signed assertion", async () => {
    const r = await post(samlResponse("PAT@acme.test"));
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/projects");
    const cookie = r.cookies.find((c) => c.name === "ob_session")!;
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `ob_session=${cookie.value}` } });
    expect(me.json().user.email).toBe("pat@acme.test");
  });

  it("rejects forged, tampered, misaddressed, expired, replayed and uninvited assertions", async () => {
    rejected(await post(samlResponse("pat@acme.test", { key: ATTACKER_KEY })), /could not be verified/);
    rejected(await post(samlResponse("pat@acme.test", { tamper: true })), /could not be verified/);
    rejected(await post(samlResponse("pat@acme.test", { audience: "https://someone-else.test" })), /could not be verified/);
    rejected(await post(samlResponse("pat@acme.test", { notOnOrAfter: new Date(Date.now() - 10 * 60_000) })), /could not be verified/);
    rejected(await post(samlResponse("stranger@acme.test")), /No OpenBuild account/);
    const once = samlResponse("pat@acme.test");
    expect((await post(once)).cookies.find((c) => c.name === "ob_session")).toBeDefined();
    rejected(await post(once), /already used/);
    const open = await post(samlResponse("pat@acme.test"), "//evil.example");
    expect(open.headers.location).toBe("/");
  });
});
