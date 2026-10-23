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
