import { createRequire } from "node:module";
import { dirname } from "node:path";
import { meshesClash, type Tri } from "./mesh-intersect.js";

/** Axis-aligned bounding box of one IFC element in model coordinates (metres). */
export interface ElementBox { expressId: number; globalId: string | null; type: string; name: string | null; min: [number, number, number]; max: [number, number, number]; tris?: Tri[] }
export interface Clash { a: ElementBox; b: ElementBox; overlap: [number, number, number]; volume: number; exact: boolean }

type WebIfc = typeof import("web-ifc");
let api: InstanceType<WebIfc["IfcAPI"]> | null = null;
let mod: WebIfc | null = null;

async function ifcApi() {
  if (!api) {
    mod = await import("web-ifc");
    api = new mod.IfcAPI();
    const dir = dirname(createRequire(import.meta.url).resolve("web-ifc"));
    api.SetWasmPath(dir + "/", true);
    await api.Init(undefined, true);
  }
  return { api, mod: mod! };
}

/**
 * Streams every product mesh with web-ifc, applies its placement matrix, and returns one world-space
 * bounding box per element. Used for coarse (bounding-box) clash detection between models.
 */
export async function elementBoxes(data: Uint8Array): Promise<ElementBox[]> {
  const { api } = await ifcApi();
  const model = api.OpenModel(data, { COORDINATE_TO_ORIGIN: false });
  const boxes = new Map<number, ElementBox>();
  try {
    api.StreamAllMeshes(model, (mesh) => {
      const geoms = mesh.geometries;
      for (let g = 0; g < geoms.size(); g++) {
        const pg = geoms.get(g);
        const geo = api.GetGeometry(model, pg.geometryExpressID);
        const verts = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
        const index = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
        const m = pg.flatTransformation;
        let box = boxes.get(mesh.expressID);
        // Vertex layout: x, y, z, nx, ny, nz
        for (let i = 0; i < verts.length; i += 6) {
          const x = verts[i]!, y = verts[i + 1]!, z = verts[i + 2]!;
          const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
          const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
          const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
          if (!box) {
            const line = api.GetLine(model, mesh.expressID) as { GlobalId?: { value: string }; Name?: { value: string } | null; constructor: { name: string } };
            box = { expressId: mesh.expressID, globalId: line?.GlobalId?.value ?? null, type: api.GetNameFromTypeCode(api.GetLineType(model, mesh.expressID)), name: line?.Name?.value ?? null, min: [wx, wy, wz], max: [wx, wy, wz] };
            boxes.set(mesh.expressID, box);
          }
          box.min = [Math.min(box.min[0], wx), Math.min(box.min[1], wy), Math.min(box.min[2], wz)];
          box.max = [Math.max(box.max[0], wx), Math.max(box.max[1], wy), Math.max(box.max[2], wz)];
        }
        // World-space triangles for exact interference checks.
        const world = (vi: number) => {
          const x = verts[vi * 6]!, y = verts[vi * 6 + 1]!, z = verts[vi * 6 + 2]!;
          return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
        };
        const tris = (box!.tris ??= []);
        for (let t = 0; t < index.length; t += 3) tris.push(Float64Array.from([...world(index[t]!), ...world(index[t + 1]!), ...world(index[t + 2]!)]));
        geo.delete();
      }
    });
  } finally {
    api.CloseModel(model);
  }
  return [...boxes.values()];
}

/**
 * Hard clashes: element pairs (one from each model) whose bounding boxes overlap by more than `tolerance`
 * metres on every axis. Sweep-and-prune on X keeps this near-linear for typical models.
 */
export function findClashes(a: ElementBox[], b: ElementBox[], tolerance = 0.01, limit = 500, exact = true): Clash[] {
  const all = [...a.map((e) => ({ e, side: 0 })), ...b.map((e) => ({ e, side: 1 }))].sort((p, q) => p.e.min[0] - q.e.min[0]);
  const active: typeof all = [];
  const out: Clash[] = [];
  for (const cur of all) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i]!.e.max[0] < cur.e.min[0]) active.splice(i, 1);
    for (const o of active) {
      if (o.side === cur.side) continue;
      const ov = [0, 1, 2].map((k) => Math.min(o.e.max[k]!, cur.e.max[k]!) - Math.max(o.e.min[k]!, cur.e.min[k]!)) as [number, number, number];
      if (ov.every((v) => v > tolerance)) {
        const [ea, eb] = o.side === 0 ? [o.e, cur.e] : [cur.e, o.e];
        // Boxes overlap; confirm with the real surfaces when meshes are available (diagonals, curves, L-shapes).
        const confirm = exact && ea.tris?.length && eb.tris?.length;
        if (confirm) {
          const lo = [0, 1, 2].map((k) => Math.max(ea.min[k]!, eb.min[k]!) - tolerance);
          const hi = [0, 1, 2].map((k) => Math.min(ea.max[k]!, eb.max[k]!) + tolerance);
          if (!meshesClash(ea.tris!, eb.tris!, { min: lo, max: hi })) continue;
        }
        out.push({ a: ea, b: eb, overlap: ov.map((v) => Math.round(v * 1000) / 1000) as [number, number, number], volume: Math.round(ov[0] * ov[1] * ov[2] * 1e6) / 1e6, exact: !!confirm });
        if (out.length >= limit) return out;
      }
    }
    active.push(cur);
  }
  return out.sort((x, y) => y.volume - x.volume);
}
