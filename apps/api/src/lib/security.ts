import type { Queryable } from "../db/db.js";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A bearer secret handed to the client; only its SHA-256 is stored. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Fixed-window limiter kept in the database, so every app instance behind a load balancer shares one count.
 * One atomic upsert per hit: a new or expired window restarts at 1, otherwise the count goes up. Keys are hashed.
 */
export class RateLimiter {
  constructor(private db: Queryable, private name: string, private limit: number, private windowMs: number) {}
  async hit(subject: string): Promise<boolean> {
    const key = sha256(`${this.name}|${subject}`);
    const [r] = await this.db.query<{ count: number }>(
      `INSERT INTO auth_rate_limits (key, count, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2))
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN auth_rate_limits.reset_at <= now() THEN 1 ELSE auth_rate_limits.count + 1 END,
         reset_at = CASE WHEN auth_rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE auth_rate_limits.reset_at END
       RETURNING count`,
      [key, this.windowMs / 1000],
    );
    // Occasionally clear expired windows so the table stays small.
    if (Math.random() < 0.01) await this.db.query("DELETE FROM auth_rate_limits WHERE reset_at < now()");
    return r!.count <= this.limit;
  }
}
