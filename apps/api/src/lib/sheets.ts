import { PDFDocument } from "pdf-lib";

/** Sheet numbers like A-101, S201, M-1.01, FP-2, E3.1A. */
const SHEET_RE = /^[A-Z]{1,3}[-.]?\d{1,3}(?:\.\d{1,2})?[A-Z]?$/;
const LABELS = /^(SHEET|SHEET NO\.?|SHEET NUMBER|DRAWING|DRAWING NO\.?|DRAWING TITLE|SHEET TITLE|TITLE|SCALE|DATE|PROJECT|PROJECT NO\.?|DRAWN BY|CHECKED BY|REVISIONS?|ISSUE|NO\.?|DESCRIPTION|NORTH|KEY PLAN|SEAL|CONSULTANT|OWNER|ARCHITECT)\b:?$/i;

export const DISCIPLINES: Record<string, string> = {
  G: "General", C: "Civil", L: "Landscape", A: "Architectural", I: "Interiors", S: "Structural", M: "Mechanical",
  P: "Plumbing", FP: "Fire protection", F: "Fire protection", E: "Electrical", T: "Telecommunications", Q: "Equipment",
};

export function disciplineOf(number: string): string {
  const prefix = /^[A-Z]+/.exec(number)?.[0] ?? "";
  return DISCIPLINES[prefix] ?? DISCIPLINES[prefix[0] ?? ""] ?? "General";
}

interface Item { str: string; x: number; y: number; h: number }
export interface DetectedSheet { page: number; number: string | null; title: string | null; discipline: string }

/**
 * Reads each page's text layer and guesses the sheet number and title from the title block (the bottom-right of the
 * sheet): the number is the largest token shaped like a sheet number there; the title is the largest wordy text near it
 * that isn't a title-block label. Scanned sheets without a text layer come back blank for the user to fill in.
 */
export async function detectSheets(data: Uint8Array): Promise<DetectedSheet[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const out: DetectedSheet[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: Item[] = [];
      for (const it of content.items as { str?: string; transform?: number[]; height?: number }[]) {
        const str = (it.str ?? "").trim();
        if (!str || !it.transform) continue;
        items.push({ str, x: it.transform[4]! / vp.width, y: it.transform[5]! / vp.height, h: (it.height ?? 0) / vp.height });
      }
      // Title block: right 45 % and bottom 35 % of the sheet (PDF y grows upwards).
      const inBlock = (i: Item) => i.x > 0.55 && i.y < 0.35;
      const numbers = items.filter((i) => SHEET_RE.test(i.str.replace(/\s+/g, "")));
      const score = (i: Item) => i.h * 10 + (inBlock(i) ? 1 : 0) + i.x * 0.2 + (1 - i.y) * 0.2;
      const num = numbers.sort((a, b) => score(b) - score(a))[0] ?? null;
      let title: string | null = null;
      if (num) {
        const wordy = items.filter((i) => i !== num && inBlock(i) && /[A-Za-z]{3,}/.test(i.str) && !LABELS.test(i.str) && !SHEET_RE.test(i.str.replace(/\s+/g, "")) && i.str.length <= 80);
        const near = (i: Item) => Math.abs(i.y - num.y) + Math.abs(i.x - num.x) * 0.5;
        const best = wordy.sort((a, b) => b.h - a.h || near(a) - near(b))[0];
        title = best ? best.str.replace(/\s+/g, " ") : null;
      }
      const number = num ? num.str.replace(/\s+/g, "") : null;
      out.push({ page: p, number, title, discipline: number ? disciplineOf(number) : "General" });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** One single-page PDF per requested page (1-based). */
export async function splitPages(data: Uint8Array, pages: number[]): Promise<Map<number, Uint8Array>> {
  const src = await PDFDocument.load(data, { ignoreEncryption: true });
  const out = new Map<number, Uint8Array>();
  for (const p of pages) {
    if (p < 1 || p > src.getPageCount()) throw new Error(`Page ${p} does not exist`);
    const doc = await PDFDocument.create();
    const [copy] = await doc.copyPages(src, [p - 1]);
    doc.addPage(copy!);
    out.set(p, await doc.save());
  }
  return out;
}
