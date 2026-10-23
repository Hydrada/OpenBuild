import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

/** RFC 6238 TOTP (SHA-1, 30 s step, 6 digits). */
export function totp(secret: string, time = Date.now(), digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1]! & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/** Accepts the current code or one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((w) => {
    const expected = Buffer.from(totp(secret, time + w * 30_000));
    return timingSafeEqual(expected, Buffer.from(code));
  });
}
