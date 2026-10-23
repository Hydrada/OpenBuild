/**
 * Generates a small but geometrically real IFC4 file: each box is an IfcBuildingElementProxy (or given type)
 * with an extruded rectangle placed at (x, y, z). Sizes in metres.
 */
export interface Box { type?: string; name: string; x: number; y: number; z: number; dx: number; dy: number; dz: number }

export function ifcWithBoxes(boxes: Box[], projectName = "Test"): Buffer {
  let n = 100;
  const L: string[] = [];
  const add = (s: string) => { const id = n++; L.push(`#${id}=${s};`); return `#${id}`; };
  const gid = () => Array.from({ length: 22 }, () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"[Math.floor(Math.random() * 64)]).join("");
  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))");
  const zAxis = add("IFCDIRECTION((0.,0.,1.))");
  const xAxis = add("IFCDIRECTION((1.,0.,0.))");
  const world = add(`IFCAXIS2PLACEMENT3D(${origin},${zAxis},${xAxis})`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${world},$)`);
  const unit = add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
  const units = add(`IFCUNITASSIGNMENT((${unit}))`);
  const project = add(`IFCPROJECT('${gid()}',$,'${projectName}',$,$,$,$,(${ctx}),${units})`);
  const sitePl = add(`IFCLOCALPLACEMENT($,${world})`);
  const site = add(`IFCSITE('${gid()}',$,'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  add(`IFCRELAGGREGATES('${gid()}',$,$,$,${project},(${site}))`);
  const elems: string[] = [];
  for (const b of boxes) {
    const pt = add(`IFCCARTESIANPOINT((${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)}))`);
    const ax = add(`IFCAXIS2PLACEMENT3D(${pt},${zAxis},${xAxis})`);
    const lp = add(`IFCLOCALPLACEMENT(${sitePl},${ax})`);
    const c2 = add(`IFCCARTESIANPOINT((${(b.dx / 2).toFixed(3)},${(b.dy / 2).toFixed(3)}))`);
    const a2 = add(`IFCAXIS2PLACEMENT2D(${c2},$)`);
    const rect = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${a2},${b.dx.toFixed(3)},${b.dy.toFixed(3)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${rect},${world},${zAxis},${b.dz.toFixed(3)})`);
    const rep = add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${solid}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${rep}))`);
    const type = (b.type ?? "IFCBUILDINGELEMENTPROXY").toUpperCase();
    const tail = type === "IFCBUILDINGELEMENTPROXY" ? "$" : type === "IFCDUCTSEGMENT" || type === "IFCPIPESEGMENT" ? "$" : "$";
    elems.push(add(`${type}('${gid()}',$,'${b.name}',$,$,${lp},${shape},$,${tail})`));
  }
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid()}',$,$,$,(${elems.join(",")}),${site})`);
  return Buffer.from(["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');", "FILE_NAME('t.ifc','2026-10-22T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;", ...L, "ENDSEC;", "END-ISO-10303-21;"].join("\n"));
}
