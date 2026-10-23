import { D, dec, fmt, sum } from "./money.js";

export type Curve = "linear" | "front" | "back" | "s_curve";

/** Months "YYYY-MM" from start to end inclusive. */
export function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let y = +start.slice(0, 4), m = +start.slice(5, 7);
  const ey = +end.slice(0, 4), em = +end.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
    if (out.length > 600) break;
  }
  return out;
}

/** Relative weight of each of n periods for a curve (front/back are linear ramps; the S-curve is a sine bell). */
export function weights(n: number, curve: Curve): number[] {
  if (n <= 0) return [];
  const w = Array.from({ length: n }, (_, i) => {
    const x = (i + 0.5) / n;
    switch (curve) {
      case "front": return 2 - 1.5 * x;
      case "back": return 0.5 + 1.5 * x;
      case "s_curve": return Math.sin(Math.PI * x);
      default: return 1;
    }
  });
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / total);
}

/** Splits `amount` across the weights, half-even to cents, with the rounding remainder in the last period. */
export function spread(amount: string, curve: Curve, n: number): string[] {
  const w = weights(n, curve);
  if (!w.length) return [];
  const total = dec(amount);
  const parts = w.map((x) => total.times(new D(x.toFixed(12))).toDecimalPlaces(2, D.ROUND_HALF_EVEN));
  const diff = total.minus(sum(parts.map((p) => p.toFixed(2))));
  parts[parts.length - 1] = parts[parts.length - 1]!.plus(diff);
  return parts.map(fmt);
}
