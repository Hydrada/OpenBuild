// Load test against a running server: seeds one project with realistic volumes, then measures
// throughput and latency for the busiest read endpoints and one write endpoint.
// Usage: node scripts/load-test.mjs http://127.0.0.1:3300 [durationSeconds]
import autocannon from "autocannon";

const base = process.argv[2] ?? "http://127.0.0.1:3300";
const duration = Number(process.argv[3] ?? 10);
const H = { "content-type": "application/json", "x-openbuild-csrf": "1" };
let cookie = "";

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { ...H, cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const tag = Date.now().toString(36);
await call("POST", "/api/auth/register", { email: `load-${tag}@acme.test`, password: "correct horse battery", name: "Load Tester", orgName: `Load ${tag}` });
const me = await call("GET", "/api/me");
const orgId = me.orgs[0].id;
const project = await call("POST", `/api/orgs/${orgId}/projects`, { name: "Load tower" });
const P = `/api/projects/${project.id}`;

console.log("Seeding: 300 RFIs, 300 punch items, 200 tasks, 60 daily logs, budget with 40 cost codes…");
const t0 = Date.now();
const batch = async (n, fn) => { for (let i = 0; i < n; i += 20) await Promise.all(Array.from({ length: Math.min(20, n - i) }, (_, j) => fn(i + j))); };
await batch(300, (i) => call("POST", `${P}/rfis`, { subject: `RFI ${i}`, question: "Load test question ".repeat(10) }));
await batch(300, (i) => call("POST", `${P}/punch-items`, { title: `Punch ${i}`, location: `Room ${i % 50}` }));
await batch(200, (i) => call("POST", `${P}/tasks`, { title: `Task ${i}` }));
await batch(60, (i) => call("POST", `${P}/daily-logs`, { logDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), manpower: [{ company: "Acme", workers: 8, hours: "64" }] }));
await call("POST", `${P}/cost-codes`, { csv: Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, "0")}-000,Code ${i}`).join("\n") });
console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const scenarios = [
  ["Dashboard", "GET", `/api/orgs/${orgId}/dashboard`],
  ["RFI list (300)", "GET", `${P}/rfis`],
  ["Punch list (300)", "GET", `${P}/punch-items`],
  ["Daily logs (60)", "GET", `${P}/daily-logs`],
  ["Budget report (40 codes)", "GET", `${P}/budget`],
  ["Create task", "POST", `${P}/tasks`, JSON.stringify({ title: "Load task" })],
];

const rows = [];
for (const [name, method, path, body] of scenarios) {
  const r = await autocannon({ url: base + path, method, body, connections: 20, duration, headers: { ...H, cookie } });
  const errors = r.errors + r.non2xx;
  rows.push({ name, rps: Math.round(r.requests.average), p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99, errors });
  console.log(`${name.padEnd(26)} ${String(Math.round(r.requests.average)).padStart(6)} req/s  p50 ${r.latency.p50} ms  p99 ${r.latency.p99} ms  errors ${errors}`);
}
console.log("\n" + JSON.stringify({ duration, connections: 20, rows }, null, 2));
if (rows.some((r) => r.errors > 0)) process.exit(1);
