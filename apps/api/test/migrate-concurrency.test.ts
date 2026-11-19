import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPgliteDb, createPostgresDb, type Db } from "../src/db/db.js";
import { migrate } from "../src/db/migrate.js";
import { migrations } from "../src/db/migrations/index.js";

/**
 * Two app instances starting at once against an empty database used to race: both created schema_migrations and
 * ran the same migrations, and one crashed. Each migration must now run exactly once.
 */
describe("concurrent migrations", () => {
  it("applies every migration exactly once when two instances start together", async () => {
    let a: Db, b: Db;
    let cleanup = async () => {};
    const url = process.env.TEST_DATABASE_URL;
    if (url) {
      // Real PostgreSQL (CI): two separate connection pools on one fresh schema.
      const schema = `mig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query(`CREATE SCHEMA ${schema}`);
      a = await createPostgresDb(url, schema);
      b = await createPostgresDb(url, schema);
      cleanup = async () => { await a.close(); await b.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
    } else {
      a = await createPgliteDb();
      b = a;
      cleanup = async () => { await a.close(); };
    }
    try {
      const [ra, rb] = await Promise.all([migrate(a), migrate(b)]);
      expect([...ra, ...rb].sort()).toEqual(migrations.map((m) => m.id).sort());
      expect(ra.filter((id) => rb.includes(id))).toEqual([]);
      const rows = await a.query<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations");
      expect(rows[0]!.n).toBe(migrations.length);
      expect(await migrate(b)).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
