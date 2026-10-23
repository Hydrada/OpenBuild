/**
 * Exact mesh interference tests used to confirm bounding-box clash candidates.
 * Triangles are flat arrays [ax, ay, az, bx, by, bz, cx, cy, cz].
 */
export type Tri = Float64Array | number[];

const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const v = (t: Tri, i: number) => [t[i * 3]!, t[i * 3 + 1]!, t[i * 3 + 2]!];

/**
 * Triangle–triangle intersection by the separating axis theorem (13 axes: 2 face normals + 9 edge cross products).
 * `eps` > 0 shrinks the test so faces that merely touch (shared or coplanar boundaries) do not count as clashes.
 */
export function trianglesIntersect(t1: Tri, t2: Tri, eps = 1e-6): boolean {
  const A = [v(t1, 0), v(t1, 1), v(t1, 2)];
  const B = [v(t2, 0), v(t2, 1), v(t2, 2)];
  const eA = [sub(A[1]!, A[0]!), sub(A[2]!, A[1]!), sub(A[0]!, A[2]!)];
  const eB = [sub(B[1]!, B[0]!), sub(B[2]!, B[1]!), sub(B[0]!, B[2]!)];
  const axes = [cross(eA[0]!, eA[1]!), cross(eB[0]!, eB[1]!)];
  for (const a of eA) for (const b of eB) axes.push(cross(a, b));
  for (const ax of axes) {
    const len = Math.hypot(ax[0]!, ax[1]!, ax[2]!);
    if (len < 1e-12) continue; // parallel edges give no axis
    const pa = A.map((p) => dot(p, ax) / len);
    const pb = B.map((p) => dot(p, ax) / len);
    if (Math.max(...pa) - eps <= Math.min(...pb) || Math.max(...pb) - eps <= Math.min(...pa)) return false;
  }
  return true;
}

/** Ray-parity point-in-closed-mesh test (ray along +X with a small skew to avoid edge hits). */
export function pointInMesh(p: number[], tris: Tri[]): boolean {
  const dir = [1, 1e-4, 1.7e-4];
  let hits = 0;
  for (const t of tris) {
    // Möller–Trumbore
    const a = v(t, 0), e1 = sub(v(t, 1), a), e2 = sub(v(t, 2), a);
    const h = cross(dir, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(p, a);
    const u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const w = dot(dir, q) / det;
    if (w < 0 || u + w > 1) continue;
    if (dot(e2, q) / det > 1e-9) hits++;
  }
  return hits % 2 === 1;
}

/** True when the meshes interpenetrate (surfaces cross) or one is fully inside the other. */
export function meshesClash(a: Tri[], b: Tri[], box: { min: number[]; max: number[] }): boolean {
  // Only triangles that reach into the overlap region can intersect.
  const inBox = (t: Tri) => {
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(t[k]!, t[k + 3]!, t[k + 6]!), hi = Math.max(t[k]!, t[k + 3]!, t[k + 6]!);
      if (hi < box.min[k]! || lo > box.max[k]!) return false;
    }
    return true;
  };
  const ta = a.filter(inBox), tb = b.filter(inBox);
  for (const x of ta) for (const y of tb) if (trianglesIntersect(x, y)) return true;
  // Containment: test each mesh's vertex centroid (inside a closed, roughly convex element) against the other.
  return (a.length > 0 && pointInMesh(centroid(a), b)) || (b.length > 0 && pointInMesh(centroid(b), a));
}

function centroid(tris: Tri[]): number[] {
  const c = [0, 0, 0];
  for (const t of tris) for (let i = 0; i < 9; i++) c[i % 3]! += t[i]!;
  return c.map((x) => x / (tris.length * 3));
}

// ---------- Distance (soft / clearance clashes) ----------

const len3 = (a: number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number[], d: number[], s: number) => [a[0]! + d[0]! * s, a[1]! + d[1]! * s, a[2]! + d[2]! * s];

/** Closest distance from point p to triangle t (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDistance(p: number[], t: Tri): number {
  const a = v(t, 0), b = v(t, 1), c = v(t, 2);
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len3(ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len3(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return len3(sub(p, lerp(a, ab, d1 / (d1 - d3))));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len3(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return len3(sub(p, lerp(a, ac, d2 / (d2 - d6))));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return len3(sub(p, lerp(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))));
  const denom = 1 / (va + vb + vc), sv = vb * denom, sw = vc * denom;
  return len3(sub(p, [a[0]! + ab[0]! * sv + ac[0]! * sw, a[1]! + ab[1]! * sv + ac[1]! * sw, a[2]! + ab[2]! * sv + ac[2]! * sw]));
}

/** Closest distance between segments p1-q1 and p2-q2 (Ericson 5.1.9). */
export function segmentDistance(p1: number[], q1: number[], p2: number[], q2: number[]): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) return len3(r);
  if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den !== 0 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return len3(sub(lerp(p1, d1, s), lerp(p2, d2, t)));
}

/** Minimum distance between two non-intersecting triangles: vertex-face both ways plus all edge-edge pairs. */
export function triangleDistance(t1: Tri, t2: Tri): number {
  let d = Infinity;
  for (let i = 0; i < 3; i++) d = Math.min(d, pointTriangleDistance(v(t1, i), t2), pointTriangleDistance(v(t2, i), t1));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) d = Math.min(d, segmentDistance(v(t1, i), v(t1, (i + 1) % 3), v(t2, j), v(t2, (j + 1) % 3)));
  return d;
}

/** Minimum surface distance between two meshes, considering only triangles that reach into `box`. */
export function meshDistance(a: Tri[], b: Tri[], box: { min: number[]; max: number[] }): number {
  const near = (t: Tri) => {
    for (let k = 0; k < 3; k++) {
      const lo = Math.min(t[k]!, t[k + 3]!, t[k + 6]!), hi = Math.max(t[k]!, t[k + 3]!, t[k + 6]!);
      if (hi < box.min[k]! || lo > box.max[k]!) return false;
    }
    return true;
  };
  const ta = a.filter(near), tb = b.filter(near);
  let d = Infinity;
  for (const x of ta) for (const y of tb) d = Math.min(d, triangleDistance(x, y));
  return d;
}
