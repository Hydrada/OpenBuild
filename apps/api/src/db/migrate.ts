import type { Db } from "./db.js";
import { migrations } from "./migrations/index.js";

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ id: string }>("SELECT id FROM schema_migrations")).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.tx(async (q) => {
      // Statements are split on ';' at line end so both drivers accept them (PGlite's
      // extended protocol, like pg with params, takes one statement per call).
      for (const stmt of splitSql(m.sql)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}

function splitSql(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
