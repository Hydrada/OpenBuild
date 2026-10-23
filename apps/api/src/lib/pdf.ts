import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/** Letter, portrait, 0.6" margins. */
const W = 612, H = 792, M = 43;
const INK = rgb(0.1, 0.1, 0.12), MUTED = rgb(0.42, 0.42, 0.45), RULE = rgb(0.8, 0.8, 0.82), HEAD_BG = rgb(0.94, 0.94, 0.95);

/** The standard PDF fonts only cover WinAnsi; map common typography and drop anything else. */
export function safe(text: unknown): string {
  return String(text ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/→/g, "->").replace(/…/g, "...")
    .replace(/≥/g, ">=").replace(/≤/g, "<=").replace(/ /g, " ").replace(/\t/g, "    ")
    .replace(/[^\x20-\x7E\n -ÿ–—•€×]/g, "?");
}

export interface Column { label: string; width: number; align?: "left" | "right" }

/** Minimal flowing document: headings, key/value blocks, wrapped paragraphs and tables, with page numbers. */
export class PdfDoc {
  private doc!: PDFDocument;
  private font!: PDFFont;
  private bold!: PDFFont;
  private page!: PDFPage;
  private y = 0;
  private constructor(private title: string, private subtitle: string) {}

  static async create(title: string, subtitle: string) {
    const d = new PdfDoc(title, subtitle);
    d.doc = await PDFDocument.create();
    d.doc.setTitle(safe(title));
    d.doc.setProducer("OpenBuild");
    d.font = await d.doc.embedFont(StandardFonts.Helvetica);
    d.bold = await d.doc.embedFont(StandardFonts.HelveticaBold);
    d.newPage();
    return d;
  }

  private newPage() {
    this.page = this.doc.addPage([W, H]);
    this.y = H - M;
    this.page.drawText(safe(this.subtitle), { x: M, y: this.y - 9, size: 9, font: this.font, color: MUTED });
    this.y -= 26;
    this.page.drawText(safe(this.title).slice(0, 90), { x: M, y: this.y - 8, size: 16, font: this.bold, color: INK });
    this.y -= 22;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.8, color: RULE });
    this.y -= 14;
  }

  private ensure(h: number) {
    if (this.y - h < M + 20) this.newPage();
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const para of safe(text).split("\n")) {
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
        if (line.trim()) out.push(line.trimEnd());
        line = word.trimStart();
        // A single word longer than the width is hard-split.
        while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      out.push(line.trimEnd());
    }
    return out;
  }

  heading(text: string) {
    this.ensure(30);
    this.y -= 6;
    this.page.drawText(safe(text), { x: M, y: this.y - 11, size: 12, font: this.bold, color: INK });
    this.y -= 20;
    return this;
  }

  paragraph(text: string | null | undefined, size = 10) {
    for (const line of this.wrap(text || "-", this.font, size, W - 2 * M)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: M, y: this.y - size, size, font: this.font, color: INK });
      this.y -= size + 4;
    }
    this.y -= 4;
    return this;
  }

  /** Two-column label/value grid. */
  fields(items: [string, unknown][]) {
    const labelW = 130, size = 10;
    for (const [k, v] of items) {
      const lines = this.wrap(v === null || v === undefined || v === "" ? "-" : String(v), this.font, size, W - 2 * M - labelW);
      this.ensure(lines.length * (size + 4));
      this.page.drawText(safe(k), { x: M, y: this.y - size, size, font: this.bold, color: MUTED });
      for (const line of lines) {
        this.page.drawText(line, { x: M + labelW, y: this.y - size, size, font: this.font, color: INK });
        this.y -= size + 4;
      }
      this.y -= 2;
    }
    this.y -= 4;
    return this;
  }

  /** Table with wrapped cells; widths are fractions of the printable width and the header repeats on new pages. */
  table(cols: Column[], rows: unknown[][], opts: { size?: number; boldLast?: boolean } = {}) {
    const size = opts.size ?? 8.5, pad = 3, total = W - 2 * M;
    const widths = cols.map((c) => c.width * total);
    const drawHeader = () => {
      const lines = cols.map((c, i) => this.wrap(c.label, this.bold, size, widths[i]! - 2 * pad));
      const h = Math.max(...lines.map((l) => l.length)) * (size + 2) + 2 * pad;
      this.ensure(h + size + 8);
      this.page.drawRectangle({ x: M, y: this.y - h, width: total, height: h, color: HEAD_BG });
      let x = M;
      cols.forEach((c, i) => {
        lines[i]!.forEach((ln, j) => {
          const tw = this.bold.widthOfTextAtSize(ln, size);
          this.page.drawText(ln, { x: c.align === "right" ? x + widths[i]! - pad - tw : x + pad, y: this.y - pad - (j + 1) * (size + 2) + 2, size, font: this.bold, color: INK });
        });
        x += widths[i]!;
      });
      this.y -= h;
    };
    drawHeader();
    rows.forEach((row, ri) => {
      const font = opts.boldLast && ri === rows.length - 1 ? this.bold : this.font;
      const lines = cols.map((_, i) => this.wrap(row[i] === null || row[i] === undefined ? "" : String(row[i]), font, size, widths[i]! - 2 * pad));
      const h = Math.max(1, ...lines.map((l) => l.length)) * (size + 2) + 2 * pad;
      if (this.y - h < M + 20) { this.newPage(); drawHeader(); }
      let x = M;
      cols.forEach((c, i) => {
        lines[i]!.forEach((ln, j) => {
          const tw = font.widthOfTextAtSize(ln, size);
          this.page.drawText(ln, { x: c.align === "right" ? x + widths[i]! - pad - tw : x + pad, y: this.y - pad - (j + 1) * (size + 2) + 2, size, font, color: INK });
        });
        x += widths[i]!;
      });
      this.y -= h;
      this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.4, color: RULE });
    });
    this.y -= 10;
    return this;
  }

  /** Signature lines (e.g. "Contractor", "Architect"). */
  signatures(labels: string[]) {
    this.ensure(60);
    this.y -= 30;
    const w = (W - 2 * M - (labels.length - 1) * 20) / labels.length;
    labels.forEach((l, i) => {
      const x = M + i * (w + 20);
      this.page.drawLine({ start: { x, y: this.y }, end: { x: x + w, y: this.y }, thickness: 0.6, color: INK });
      this.page.drawText(safe(`${l}   Date`), { x, y: this.y - 11, size: 8, font: this.font, color: MUTED });
    });
    this.y -= 24;
    return this;
  }

  async bytes(): Promise<Uint8Array> {
    const pages = this.doc.getPages();
    const stamp = `Generated by OpenBuild ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
    pages.forEach((p, i) => {
      p.drawText(stamp, { x: M, y: M - 18, size: 7.5, font: this.font, color: MUTED });
      const n = `Page ${i + 1} of ${pages.length}`;
      p.drawText(n, { x: W - M - this.font.widthOfTextAtSize(n, 7.5), y: M - 18, size: 7.5, font: this.font, color: MUTED });
    });
    return this.doc.save();
  }
}
