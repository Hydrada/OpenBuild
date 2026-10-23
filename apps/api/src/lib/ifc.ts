/** Element types summarised from an IFC (ISO 10303-21 / STEP) file. Standard-case subtypes roll up into their parent. */
const TYPES: Record<string, string> = {
  IFCWALL: "Walls", IFCWALLSTANDARDCASE: "Walls", IFCCURTAINWALL: "Curtain walls", IFCDOOR: "Doors", IFCWINDOW: "Windows",
  IFCSLAB: "Slabs", IFCCOLUMN: "Columns", IFCBEAM: "Beams", IFCSTAIR: "Stairs", IFCROOF: "Roofs", IFCRAILING: "Railings",
  IFCSPACE: "Spaces", IFCBUILDINGSTOREY: "Storeys", IFCFOOTING: "Footings", IFCPILE: "Piles", IFCMEMBER: "Members",
  IFCPLATE: "Plates", IFCCOVERING: "Coverings", IFCFURNISHINGELEMENT: "Furnishings",
  IFCFLOWSEGMENT: "MEP segments", IFCPIPESEGMENT: "MEP segments", IFCDUCTSEGMENT: "MEP segments", IFCCABLESEGMENT: "MEP segments",
  IFCFLOWTERMINAL: "MEP terminals", IFCAIRTERMINAL: "MEP terminals", IFCLIGHTFIXTURE: "MEP terminals", IFCSANITARYTERMINAL: "MEP terminals",
};

export function isIfc(data: Buffer): boolean {
  return data.subarray(0, 64).toString("latin1").trimStart().startsWith("ISO-10303-21;");
}

/** Reads the schema from the header and counts entity instances such as "#12=IFCWALL(...)" in the DATA section. */
export function summarizeIfc(data: Buffer): { schema: string | null; counts: Record<string, number> } {
  const text = data.toString("latin1");
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text)?.[1] ?? null;
  const counts: Record<string, number> = {};
  const re = /#\d+\s*=\s*(IFC[A-Z0-9]+)\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const label = TYPES[m[1]!];
    if (label) counts[label] = (counts[label] ?? 0) + 1;
  }
  return { schema, counts };
}
