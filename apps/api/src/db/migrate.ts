import type { Db } from "./db.js";
import { migrations } from "./migrations/index.js";

/** Arbitrary constant naming OpenBuild's migration lock (pg_advisory_xact_lock key). */
const MIGRATION_LOCK = 7_310_420_611;

/**
 * Applies pending migrations. Safe when several app instances start at once against the same database: each step
 * runs in a transaction that first takes a transaction-scoped advisory lock and then re-checks whether another
 * instance already applied it, so every migration runs exactly once and late starters simply wait.
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await q.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  });
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM schema_migrations")).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    const ran = await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      if ((await q.query("SELECT 1 FROM schema_migrations WHERE id = $1", [m.id])).length) return false;
      // One statement per call: PGlite's extended protocol, like pg with params, accepts a single statement.
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
      return true;
    });
    if (ran) applied.push(m.id);
  }
  return applied;
}

/** Splits on statement-ending semicolons, keeping $tag$ ... $tag$ bodies (functions) intact. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let dollar: string | null = null;
  for (const line of sql.replace(/\r/g, "").split("\n")) {
    if (!dollar && /^\s*--/.test(line)) continue;
    cur += line + "\n";
    for (const m of line.matchAll(/\$[A-Za-z_]*\$/g)) dollar = dollar === null ? m[0] : dollar === m[0] ? null : dollar;
    if (!dollar && /;\s*$/.test(line)) {
      out.push(cur.trim().replace(/;$/, ""));
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
