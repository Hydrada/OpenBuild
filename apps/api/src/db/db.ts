import { mkdirSync } from "node:fs";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

/** Minimal query surface shared by the production (node-postgres) and embedded (PGlite) drivers. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs `fn` inside a single transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: "postgres" | "pglite";
}

// Return NUMERIC as strings so money never passes through a JS float.
pg.types.setTypeParser(1700, (v) => v);

export function createPostgresDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    driver: "postgres",
    async query(sql, params) {
      const r = await pool.query(sql, params as unknown[]);
      return r.rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query(sql, params) {
            return (await client.query(sql, params as unknown[])).rows;
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Embedded Postgres for development, tests and single-machine evaluation. `dataDir` undefined = in-memory. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const lite = new PGlite(dataDir, {
    parsers: { 1700: (v: string) => v },
  });
  await lite.waitReady;
  return {
    driver: "pglite",
    async query(sql, params) {
      return (await lite.query(sql, params as unknown[])).rows as never;
    },
    async tx(fn) {
      return lite.transaction(async (t) =>
        fn({
          async query(sql, params) {
            return (await t.query(sql, params as unknown[])).rows as never;
          },
        }),
      );
    },
    close: () => lite.close(),
  };
}

export async function createDb(env: { DATABASE_URL?: string; PGLITE_DIR?: string }): Promise<Db> {
  if (env.DATABASE_URL) return createPostgresDb(env.DATABASE_URL);
  return createPgliteDb(env.PGLITE_DIR ?? "./data/pglite");
}
