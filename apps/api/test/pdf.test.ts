import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safe } from "../src/lib/pdf.js";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

/** Text drawn with the standard fonts ends up as hex strings inside Flate-compressed content streams. */
function textOf(pdf: Buffer): string {
  const s = pdf.toString("latin1");
  let out = "";
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"); } catch { continue; }
    for (const h of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out += Buffer.from(h[1]!, "hex").toString("latin1") + "\n";
  }
  return out;
}

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower", code: "HT-1" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

async function pdf(c: Client, url: string) {
  const res = await c.raw(url);
  return { status: res.statusCode, type: res.headers["content-type"], disposition: String(res.headers["content-disposition"] ?? ""), body: res.rawPayload };
}

describe("PDF exports", () => {
  it("RFI PDF carries the question and the official answer, and follows RFI visibility", async () => {
    const sub = await inviteAndJoin(app, owner, orgId, "sub@example.com", { projectId, projectRole: "subcontractor" });
    const r = (await owner.post(`${P}/rfis`, { subject: "Beam depth at grid C — W18 or W21?", question: "Drawings S-201 and A-301 disagree.\nPlease confirm." })).body;
    await owner.post(`/api/rfis/${r.id}/responses`, { body: "Use W21x44 per S-201.", official: true });
    const out = await pdf(owner, `/api/rfis/${r.id}/pdf`);
    expect(out.status).toBe(200);
    expect(out.type).toBe("application/pdf");
    expect(out.disposition).toContain(`filename="RFI-${r.number}.pdf"`);
    expect(out.body.subarray(0, 5).toString()).toBe("%PDF-");
    const text = textOf(out.body);
    expect(text).toContain("Harbor Tower (#HT-1)");
    expect(text).toContain("Drawings S-201 and A-301 disagree.");
    expect(text).toContain("Use W21x44 per S-201.");
    expect(text).toContain("Beam depth at grid C — W18 or W21?".replace("—", "\x97")); // em dash in WinAnsi
    expect((await pdf(sub.client, `/api/rfis/${r.id}/pdf`)).status).toBe(404);
    const outsider = await registerOwner(app, "x@example.com");
    expect((await pdf(outsider.client, `/api/rfis/${r.id}/pdf`)).status).toBe(404);
  });

  it("pay application PDF shows the G702 totals and G703 lines", async () => {
    await owner.post(`${P}/cost-codes`, { code: "03-300", description: "Concrete" });
    const cc = (await owner.get(`${P}/cost-codes`)).body[0].id;
    const k = (await owner.post(`${P}/contracts`, { kind: "subcontract", title: "Concrete", counterparty: "Acme Concrete", retainagePercent: "10", lines: [{ costCodeId: cc, description: "Foundations", amount: "100000" }] })).body;
    await owner.post(`/api/contracts/${k.id}/status`, { status: "approved" });
    const inv = (await owner.post(`${P}/invoices`, { contractId: k.id, periodStart: "2026-10-01", periodEnd: "2026-10-31" })).body;
    const pa = (await owner.get(`/api/invoices/${inv.id}`)).body;
    await owner.req("PUT", `/api/invoices/${inv.id}/lines`, { lines: [{ key: pa.lines[0].key, workThisPeriod: "25000", materialsStored: "0" }] });
    const out = await pdf(owner, `/api/invoices/${inv.id}/pdf`);
    expect(out.status).toBe(200);
    const text = textOf(out.body);
    for (const s of ["Application for payment", "Acme Concrete", "Contract sum to date", "$100,000.00", "$25,000.00", "$2,500.00", "$22,500.00", "Continuation sheet (G703)", "Foundations"]) expect(text).toContain(s);
  });

  it("long documents flow onto more pages with numbered footers", async () => {
    const t = (await owner.post(`${P}/tm-tickets`, {
      workDate: "2026-10-05", description: "Extra work",
      lines: Array.from({ length: 120 }, (_, i) => ({ category: "labor", description: `Line ${i + 1} with a reasonably long description that wraps`, quantity: "1", rate: "10" })),
    })).body;
    const out = await pdf(owner, `/api/tm-tickets/${t.id}/pdf`);
    const doc = await PDFDocument.load(out.body);
    expect(doc.getPageCount()).toBeGreaterThan(2);
    const text = textOf(out.body);
    expect(text).toContain(`Page ${doc.getPageCount()} of ${doc.getPageCount()}`);
    expect(text).toContain("Line 120 with a reasonably long description");
    expect(text).toContain("$1,200.00");
  });

  it("daily log, meeting, change order, submittal and punch list PDFs render", async () => {
    const log = (await owner.post(`${P}/daily-logs`, { logDate: "2026-10-02", weather: "Clear", workPerformed: "Poured L2", manpower: [{ company: "Acme", trade: "Concrete", workers: 8, hours: "64" }] })).body;
    const m = (await owner.post(`${P}/meetings`, { title: "OAC #4", startsAt: "2026-10-05T09:00:00Z", agenda: ["Schedule", "RFIs"] })).body;
    const s = (await owner.post(`${P}/submittals`, { title: "Rebar shop drawings" })).body;
    await owner.post(`${P}/punch-items`, { title: "Patch drywall at 204", location: "Room 204" });
    const urls: [string, string][] = [
      [`/api/daily-logs/${log.id}/pdf`, "Poured L2"], [`/api/meetings/${m.id}/pdf`, "OAC #4"],
      [`/api/submittals/${s.id}/pdf`, "Rebar shop drawings"], [`${P}/punch-list.pdf`, "Patch drywall at 204"],
    ];
    for (const [url, expected] of urls) {
      const out = await pdf(owner, url);
      expect(out.status, url).toBe(200);
      expect(textOf(out.body), url).toContain(expected);
    }
  });

  it("maps text the standard fonts cannot encode", () => {
    expect(safe("A → B “q” ≤ 5 \u{1F600}")).toBe('A -> B "q" <= 5 ??');
  });
});
