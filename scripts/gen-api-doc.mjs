// Regenerates the endpoint table at the end of docs/API.md from the server's live route table.
// Usage: npm run build --workspace apps/api && node scripts/gen-api-doc.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const dist = (p) => new URL(`../apps/api/dist/${p}`, import.meta.url).href;
const { buildApp } = await import(dist("app.js"));
const { createPgliteDb } = await import(dist("db/db.js"));
const { migrate } = await import(dist("db/migrate.js"));
const { createNotifier } = await import(dist("lib/notify.js"));
const { LocalStorage } = await import(dist("lib/storage.js"));

const dir = mkdtempSync(join(tmpdir(), "ob-apidoc-"));
const db = await createPgliteDb();
await migrate(db);
const app = await buildApp({ db, storage: new LocalStorage(dir), allowSignup: true, secureCookies: false, notify: createNotifier(), documentTools: [], logger: false });
await app.ready();
const routes = app.routeList.filter((r) => r.url.startsWith("/api/") && r.method !== "HEAD");
await app.close();
await db.close();
rmSync(dir, { recursive: true, force: true });

const file = join(root, "docs/API.md");
const doc = readFileSync(file, "utf8");
const head = doc.slice(0, doc.indexOf("## Endpoints"));
const rows = routes.map((r) => `| \`${r.method}\` | \`${r.url}\` |`);
writeFileSync(file, `${head}## Endpoints

Generated from the server's route table (${routes.length} routes) by \`scripts/gen-api-doc.mjs\`. Permission checks are documented in [ARCHITECTURE.md](ARCHITECTURE.md#adr-004--permission-model-2026-10-22).

| Method | Path |
|---|---|
${rows.join("\n")}
`);
console.log(`docs/API.md: ${routes.length} routes`);
