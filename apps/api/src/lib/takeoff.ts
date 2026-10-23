/** Sheet points are fractions of the sheet (0..1); a scale converts them to feet or metres along each axis. */
export type Pt = [number, number];
export interface Scale { units_per_x: number; units_per_y: number; unit: "ft" | "m" }

/**
 * Calibration from two points a known distance apart. The sheet's aspect ratio (width/height in PDF points) makes the
 * axes consistent: real distance per unit of x and per unit of y differ only by that ratio.
 */
export function calibrate(a: Pt, b: Pt, distance: number, aspect: number): { units_per_x: number; units_per_y: number } {
  const dx = (b[0] - a[0]) * aspect, dy = b[1] - a[1];
  const sheet = Math.hypot(dx, dy); // in "sheet heights"
  if (!(sheet > 1e-6) || !(distance > 0)) throw new Error("Pick two different points and a positive distance");
  const perHeight = distance / sheet;
  return { units_per_x: perHeight * aspect, units_per_y: perHeight };
}

const real = (p: Pt, s: Scale): Pt => [p[0] * s.units_per_x, p[1] * s.units_per_y];

export function measure(kind: "length" | "area" | "count", points: Pt[], s: Scale): { quantity: number; unit: string } {
  if (kind === "count") return { quantity: points.length, unit: "ea" };
  const r = points.map((p) => real(p, s));
  if (kind === "length") {
    let len = 0;
    for (let i = 1; i < r.length; i++) len += Math.hypot(r[i]![0] - r[i - 1]![0], r[i]![1] - r[i - 1]![1]);
    return { quantity: Math.round(len * 1000) / 1000, unit: s.unit };
  }
  // Shoelace formula for a simple polygon.
  let twice = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i]!, [x2, y2] = r[(i + 1) % r.length]!;
    twice += x1 * y2 - x2 * y1;
  }
  return { quantity: Math.round((Math.abs(twice) / 2) * 1000) / 1000, unit: s.unit === "ft" ? "sf" : "m2" };
}
