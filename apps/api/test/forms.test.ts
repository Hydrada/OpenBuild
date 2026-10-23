import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, inviteAndJoin, makeApp, registerOwner, type App, type Db } from "./helpers.js";

let app: App;
let db: Db;
let owner: Client;
let orgId: string;
let projectId: string;
let P: string;

const FIELDS = [
  { key: "permit_no", label: "Permit number", type: "text", required: true },
  { key: "hours", label: "Hours of work", type: "number" },
  { key: "work_date", label: "Date", type: "date", required: true },
  { key: "area", label: "Area", type: "select", options: ["Roof", "Basement"], required: true },
  { key: "extinguisher", label: "Fire extinguisher present", type: "checkbox", required: true },
  { key: "approved_by", label: "Approved by", type: "signature", required: true },
];

beforeAll(async () => {
  ({ app, db } = await makeApp());
  ({ client: owner, orgId } = await registerOwner(app));
  projectId = (await owner.post(`/api/orgs/${orgId}/projects`, { name: "Harbor Tower" })).body.id;
  P = `/api/projects/${projectId}`;
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("forms", () => {
  it("builds a template, fills a form, validates, submits and locks it", async () => {
    expect((await owner.post(`/api/orgs/${orgId}/form-templates`, { name: "Bad", fields: [{ key: "a", label: "A", type: "select" }] })).status).toBe(400);
    expect((await owner.post(`/api/orgs/${orgId}/form-templates`, { name: "Dup", fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }] })).status).toBe(400);
    const t = (await owner.post(`/api/orgs/${orgId}/form-templates`, { name: "Hot work permit", fields: FIELDS })).body;
    const f = (await owner.post(`${P}/forms`, { templateId: t.id })).body;
    expect(f.number).toBe(1);

    // Editing the template later does not change the form already started.
    await owner.patch(`/api/form-templates/${t.id}`, { fields: [{ key: "x", label: "X", type: "text" }] });
    expect((await owner.get(`/api/forms/${f.id}`)).body.fields).toHaveLength(6);

    expect((await owner.req("PUT", `/api/forms/${f.id}`, { answers: { permit_no: "HW-12", hours: "4.5" } })).status).toBe(200);
    expect((await owner.req("PUT", `/api/forms/${f.id}`, { answers: { area: "Attic" } })).status).toBe(400);
    expect((await owner.req("PUT", `/api/forms/${f.id}`, { answers: { hours: "lots" } })).status).toBe(400);
    const missing = await owner.req("PUT", `/api/forms/${f.id}`, { answers: { permit_no: "HW-12", work_date: "2026-10-05", area: "Roof" }, submit: true });
    expect(missing.body.error).toBe('"Fire extinguisher present" is required');
    const ok = await owner.req("PUT", `/api/forms/${f.id}`, { answers: { permit_no: "HW-12", hours: 4.5, work_date: "2026-10-05", area: "Roof", extinguisher: true, approved_by: { name: "Sam Super" } }, submit: true });
    expect(ok.status).toBe(200);
    const d = (await owner.get(`/api/forms/${f.id}`)).body;
    expect(d).toMatchObject({ status: "submitted", submitted_by_name: "Olive Owner" });
    expect(d.answers).toMatchObject({ permit_no: "HW-12", hours: 4.5, extinguisher: true, approved_by: { name: "Sam Super" } });
    expect((await owner.req("PUT", `/api/forms/${f.id}`, { answers: {} })).status).toBe(409);
    const pdf = await owner.raw(`/api/forms/${f.id}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
  });

  it("only admins build templates; subcontractors and outsiders cannot see forms", async () => {
    const sub = await inviteAndJoin(app, owner, orgId, "s@example.com", { projectId, projectRole: "subcontractor" });
    expect((await sub.client.post(`/api/orgs/${orgId}/form-templates`, { name: "x", fields: [{ key: "a", label: "A", type: "text" }] })).status).toBe(403);
    expect((await sub.client.get(`${P}/forms`)).status).toBe(403);
    const outsider = await registerOwner(app, "x@example.com");
    const t = (await owner.get(`/api/orgs/${orgId}/form-templates`)).body[0];
    const theirs = (await outsider.client.post(`/api/orgs/${outsider.orgId}/projects`, { name: "T" })).body.id;
    expect((await outsider.client.post(`/api/projects/${theirs}/forms`, { templateId: t.id })).status).toBe(400);
  });
});
