// Installation + recovery drill against the BUILT app (run `npm run build` first):
//   1. start a fresh server, create an org/project/RFI/drawing, stop it (hard kill)
//   2. restart and confirm the data and session survived
//   3. run the backup CLI, restore into a brand-new data directory, start a second server and verify
// Usage: node scripts/smoke.mjs   (exit code 0 = pass). Set DATABASE_URL to drill against PostgreSQL;
// the restore step then needs RESTORE_DATABASE_URL pointing at a second, empty database.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const work = mkdtempSync(join(tmpdir(), "openbuild-smoke-"));
const PORT = 3400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; throw new Error(m); };

function envFor(dir, dbUrl) {
  return { ...process.env, PORT: String(PORT), NODE_ENV: "test", PGLITE_DIR: join(dir, "db"), OPENBUILD_STORAGE_DIR: join(dir, "files"), ...(dbUrl ? { DATABASE_URL: dbUrl } : { DATABASE_URL: "" }) };
}

async function start(dir, dbUrl) {
  const child = spawn(process.execPath, [join(root, "apps/api/dist/main.js")], { env: envFor(dir, dbUrl), stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGKILL");
  fail(`server did not start:\n${log}`);
}

let cookie = "";
async function call(method, path, body, form) {
  const res = await fetch(base + path, {
    method,
    headers: { "x-openbuild-csrf": "1", cookie, ...(form ? {} : { "content-type": "application/json" }) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const children = [];
try {
  const dbUrl = process.env.DATABASE_URL || undefined;
  const instanceA = join(work, "a");

  step("Fresh install starts and migrates");
  children.push(await start(instanceA, dbUrl));
  ok(`health OK on ${base}`);

  step("Create organization, project, RFI and drawing");
  await call("POST", "/api/auth/register", { email: "smoke@acme.test", password: "correct horse battery", name: "Smoke Test", orgName: "Smoke Co" });
  const me = await call("GET", "/api/me");
  const project = await call("POST", `/api/orgs/${me.orgs[0].id}/projects`, { name: "Smoke tower" });
  await call("POST", `/api/projects/${project.id}/rfis`, { subject: "Survives everything", question: "?" });
  const fd = new FormData();
  for (const [k, v] of Object.entries({ number: "A-1", title: "Plan", revision: "0" })) fd.append(k, v);
  fd.append("file", new Blob(["%PDF-1.4\n% smoke drawing\n%%EOF\n"], { type: "application/pdf" }), "a1.pdf");
  await call("POST", `/api/projects/${project.id}/drawings`, undefined, fd);
  ok("records created");

  step("Hard-kill the server and restart");
  children.pop().kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  children.push(await start(instanceA, dbUrl));
  const rfis = await call("GET", `/api/projects/${project.id}/rfis`);
  if (rfis[0]?.subject !== "Survives everything") fail("RFI missing after restart");
  ok("data and session survived an unclean shutdown");
  children.pop().kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));

  step("Backup with the CLI");
  const backupDir = join(work, "backup");
  const cli = (args, env) => spawnSync(process.execPath, [join(root, "apps/api/dist/db/backup-cli.js"), ...args], { env, encoding: "utf8" });
  const b = cli(["backup", backupDir], envFor(instanceA, dbUrl));
  if (b.status !== 0) fail(`backup failed: ${b.stderr || b.stdout}`);
  ok(b.stdout.trim());

  step("Restore into a brand-new installation");
  const instanceB = join(work, "b");
  const restoreDb = dbUrl ? process.env.RESTORE_DATABASE_URL : undefined;
  if (dbUrl && !restoreDb) fail("RESTORE_DATABASE_URL is required when DATABASE_URL is set");
  const r = cli(["restore", backupDir], envFor(instanceB, restoreDb));
  if (r.status !== 0) fail(`restore failed: ${r.stderr || r.stdout}`);
  ok(r.stdout.trim());
  const again = cli(["restore", backupDir], envFor(instanceB, restoreDb));
  if (again.status === 0) fail("restoring over existing data should be refused");
  ok("second restore into a non-empty database was refused");

  children.push(await start(instanceB, restoreDb));
  cookie = "";
  await call("POST", "/api/auth/login", { email: "smoke@acme.test", password: "correct horse battery" });
  const restored = await call("GET", `/api/projects/${project.id}/rfis`);
  if (restored[0]?.subject !== "Survives everything") fail("RFI missing after restore");
  const drawing = (await call("GET", `/api/projects/${project.id}/drawings`))[0];
  const pdf = await fetch(`${base}/api/files/${drawing.current_file_id}/download`, { headers: { cookie } });
  if (!(await pdf.text()).includes("smoke drawing")) fail("drawing file missing after restore");
  ok("restored login, records and uploaded files");
  console.log("\nSMOKE TEST PASSED");
} catch (e) {
  if (!process.exitCode) { console.error(e); process.exitCode = 1; }
} finally {
  for (const c of children) c.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 500));
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
