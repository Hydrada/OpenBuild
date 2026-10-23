/**
 * Minimal reader for Microsoft Project XML (MSPDI, "Save As > XML"), also exported by Primavera P6, ProjectLibre and GanttProject.
 * Reads tasks (UID, name, start, finish, milestone, % complete, summary flag) and finish-to-start predecessor links with lag.
 */
export interface ImportedTask { uid: string; name: string; start: string; finish: string; milestone: boolean; percent: number; predecessors: { uid: string; lagDays: number }[] }

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]!.trim()) : null;
};

export function parseMsProjectXml(xml: string): ImportedTask[] {
  if (!/<Project[\s>]/.test(xml) || !/<Tasks>/.test(xml)) throw new Error("Not a Microsoft Project XML file");
  const tasks: ImportedTask[] = [];
  for (const m of xml.matchAll(/<Task>([\s\S]*?)<\/Task>/g)) {
    const t = m[1]!;
    const uid = tag(t.replace(/<PredecessorLink>[\s\S]*?<\/PredecessorLink>/g, ""), "UID");
    const name = tag(t, "Name");
    const start = tag(t, "Start")?.slice(0, 10);
    const finish = tag(t, "Finish")?.slice(0, 10);
    if (!uid || !name || !start || !finish || uid === "0") continue; // UID 0 is the project summary task
    if (tag(t, "Summary") === "1") continue; // roll-up rows are derived, not activities
    const predecessors = [...t.matchAll(/<PredecessorLink>([\s\S]*?)<\/PredecessorLink>/g)]
      .filter((p) => (tag(p[1]!, "Type") ?? "1") === "1") // 1 = finish-to-start
      .map((p) => ({ uid: tag(p[1]!, "PredecessorUID")!, lagDays: Math.round(Number(tag(p[1]!, "LinkLag") ?? "0") / 4800) })); // LinkLag is tenths of minutes; 4800 = one 8 h day
    tasks.push({ uid, name: name.slice(0, 300), start, finish: finish < start ? start : finish, milestone: tag(t, "Milestone") === "1", percent: Math.min(100, Math.max(0, Number(tag(t, "PercentComplete") ?? "0"))), predecessors });
  }
  return tasks;
}
