import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

const H = { "x-openbuild-csrf": "1" };
export const PASSWORD = "correct horse battery";

export const uid = () => Math.random().toString(36).slice(2, 8);

export function pdf(label = "sheet") {
  return { name: `${label}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`) };
}

export function jpeg(name = "photo") {
  return { name: `${name}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]) };
}

export interface World { owner: Page; ownerCtx: BrowserContext; orgId: string; ownerId: string; projectId: string; email: string; tag: string }

/** Registers a fresh owner + project through the API (fast), leaving `owner` signed in. */
export async function world(browser: Browser, projectName = "Harbor Tower"): Promise<World> {
  const tag = uid();
  const email = `owner-${tag}@acme.test`;
  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const reg = await owner.request.post("/api/auth/register", { headers: H, data: { email, password: PASSWORD, name: "Olive Owner", orgName: `Acme ${tag}` } });
  expect(reg.status()).toBe(201);
  const me = await (await owner.request.get("/api/me")).json();
  const orgId = me.orgs[0].id;
  const p = await (await owner.request.post(`/api/orgs/${orgId}/projects`, { headers: H, data: { name: projectName } })).json();
  return { owner, ownerCtx, orgId, ownerId: me.user.id, projectId: p.id, email, tag };
}

/** Invites someone into the project and returns a page signed in as them. */
export async function member(browser: Browser, w: World, name: string, projectRole: string, extra: Record<string, unknown> = {}) {
  const email = `${name.toLowerCase().replace(/\W+/g, ".")}-${w.tag}@acme.test`;
  const inv = await (await w.owner.request.post(`/api/orgs/${w.orgId}/invitations`, { headers: H, data: { email, projectId: w.projectId, projectRole, ...extra } })).json();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const token = inv.acceptPath.split("/").pop();
  const acc = await page.request.post(`/api/invitations/${token}/accept`, { headers: H, data: { name, password: PASSWORD } });
  expect(acc.status()).toBe(200);
  const me = await (await page.request.get("/api/me")).json();
  return { page, ctx, id: me.user.id as string, email };
}

export const api = (page: Page) => ({
  get: async (path: string) => (await page.request.get(`/api${path}`)).json(),
  post: async (path: string, data: unknown = {}) => {
    const r = await page.request.post(`/api${path}`, { headers: H, data });
    if (!r.ok()) throw new Error(`${path}: ${r.status()} ${await r.text()}`);
    return r.json();
  },
});

export function tool(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Project tools" }).getByRole("link", { name, exact: true });
}

export async function openProject(page: Page, w: World, toolName?: string) {
  await page.goto(`/projects/${w.projectId}`);
  await expect(page.getByRole("heading", { level: 1, name: /Harbor Tower/ })).toBeVisible();
  if (toolName) await tool(page, toolName).click();
}
