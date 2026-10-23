import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, PDF, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

beforeEach(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  await owner.post(`/api/projects/${projectId}/cost-codes`, { code: "09-900", description: "Painting" });
});
afterEach(async () => {
  await app.close();
  await db.close();
});

describe("bidding", () => {
  it("invites bidders, collects and levels bids, and awards a subcontract", async () => {
    const cc = (await owner.get(`/api/projects/${projectId}/cost-codes`)).body[0].id;
    expect((await owner.post(`/api/projects/${projectId}/bid-packages`, { title: "x", dueAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
    const pkg = (await owner.post(`/api/projects/${projectId}/bid-packages`, { title: "Painting", scope: "All interior painting", costCodeId: cc, dueAt: future() })).body;
    const links: Record<string, string> = {};
    for (const company of ["Alpha Painting", "Bravo Coatings", "Charlie Finishes"]) {
      const r = (await owner.post(`/api/bid-packages/${pkg.id}/bidders`, { company, email: `${company.split(" ")[0]!.toLowerCase()}@bid.test` })).body;
      links[company] = r.bidPath.split("/").pop();
    }
    // Planroom: share the drawing set; only shared files are downloadable through the bid link
    const sheet = await owner.upload(`/api/projects/${projectId}/drawings`, { number: "A-501", title: "Finish plan", revision: "0" }, { name: "A-501.pdf", type: "application/pdf", data: PDF("finish plan") });
    const sheetFile = (await owner.get(`/api/drawings/${sheet.body.drawingId}`)).body.revisions[0].file_id;
    const secret = (await owner.upload(`/api/projects/${projectId}/files`, {}, { name: "budget.xlsx", type: "application/octet-stream", data: "internal" })).body;
    expect((await owner.post(`/api/bid-packages/${pkg.id}/files`, { fileId: sheetFile })).status).toBe(201);
    const anon = new Client(app); // bidders have no account and no CSRF header requirement
    expect((await anon.get(`/api/bids/${links["Alpha Painting"]}`)).body.files.map((f: { name: string }) => f.name)).toEqual(["A-501.pdf"]);
    expect((await anon.raw(`/api/bids/${links["Alpha Painting"]}/files/${sheetFile}`)).body).toContain("finish plan");
    expect((await anon.raw(`/api/bids/${links["Alpha Painting"]}/files/${secret.id}`)).statusCode).toBe(404);
    const send = (token: string, body: unknown) => app.inject({ method: "POST", url: `/api/bids/${token}`, payload: body as object });
    expect((await anon.get(`/api/bids/${links["Alpha Painting"]}`)).body).toMatchObject({ title: "Painting", company: "Alpha Painting", open: true, organization: "Acme Builders" });
    expect((await send(links["Alpha Painting"]!, { amount: "120,500.00", notes: "Two coats" })).statusCode).toBe(200);
    expect((await send(links["Alpha Painting"]!, { amount: "118500" })).statusCode).toBe(200); // revision before due
    expect((await send(links["Bravo Coatings"]!, { amount: "131,350.00" })).statusCode).toBe(200);
    expect((await send(links["Charlie Finishes"]!, { decline: true })).statusCode).toBe(200);
    expect((await send(links["Bravo Coatings"]!, { amount: "1.234" })).statusCode).toBe(400);
    expect((await send("nope", { amount: "1" })).statusCode).toBe(404);

    const lev = (await owner.get(`/api/bid-packages/${pkg.id}`)).body;
    expect(lev.low_bid).toBe("118500.00");
    expect(lev.bidders.map((b: { company: string; over_low: string | null }) => [b.company, b.over_low])).toEqual([
      ["Alpha Painting", "0.00"], ["Bravo Coatings", "12850.00"], ["Charlie Finishes", null],
    ]);
    expect(lev.bidders[1].over_low_percent).toBe("10.84");
    expect((await owner.get(`/api/projects/${projectId}/bid-packages`)).body[0]).toMatchObject({ invited: 3, submitted: 2, low_bid: "118500.00" });

    const charlie = lev.bidders.find((b: { company: string }) => b.company === "Charlie Finishes");
    expect((await owner.post(`/api/bid-packages/${pkg.id}/award`, { bidderId: charlie.id })).status).toBe(400);
    const award = await owner.post(`/api/bid-packages/${pkg.id}/award`, { bidderId: lev.bidders[0].id });
    expect(award.status).toBe(200);
    const k = (await owner.get(`/api/contracts/${award.body.contractId}`)).body;
    expect(k).toMatchObject({ kind: "subcontract", counterparty: "Alpha Painting", status: "draft" });
    expect(k.totals.original).toBe("118500.00");
    expect((await send(links["Bravo Coatings"]!, { amount: "100" })).statusCode).toBe(409); // closed after award
  });

  it("restricts management to managers and hides packages from subcontractors", async () => {
    const { client: contrib } = await inviteAndJoin(app, owner, orgId, "c@example.com", { projectId, projectRole: "contributor" });
    const { client: sub } = await inviteAndJoin(app, owner, orgId, "s@example.com", { projectId, projectRole: "subcontractor" });
    expect((await contrib.post(`/api/projects/${projectId}/bid-packages`, { title: "x", dueAt: future() })).status).toBe(403);
    expect((await sub.get(`/api/projects/${projectId}/bid-packages`)).status).toBe(403);
    const pkg = (await owner.post(`/api/projects/${projectId}/bid-packages`, { title: "Roofing", dueAt: future() })).body;
    await owner.post(`/api/bid-packages/${pkg.id}/status`, { status: "closed" });
    expect((await owner.post(`/api/bid-packages/${pkg.id}/bidders`, { company: "x", email: "x@x.test" })).status).toBe(409);
  });
});
