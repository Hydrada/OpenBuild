import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../api";
import { ErrorText } from "./ui";

type Color = "red" | "blue" | "green" | "orange" | "black";
type Shape =
  | { type: "rect" | "cloud" | "ellipse"; x: number; y: number; w: number; h: number; color: Color; label?: string }
  | { type: "arrow"; x1: number; y1: number; x2: number; y2: number; color: Color }
  | { type: "text"; x: number; y: number; text: string; color: Color }
  | { type: "pen"; points: [number, number][]; color: Color };
type Tool = "view" | "rect" | "cloud" | "ellipse" | "arrow" | "text" | "pen";
interface Layer { id: string; author_name: string; shapes: Shape[]; published_at: string | null }

const COLORS: Record<Color, string> = { red: "#c81e1e", blue: "#1d4ed8", green: "#15803d", orange: "#c2410c", black: "#111827" };
const TOOLS: [Tool, string][] = [["view", "Pan"], ["rect", "Box"], ["cloud", "Cloud"], ["ellipse", "Ellipse"], ["arrow", "Arrow"], ["text", "Text"], ["pen", "Pen"]];

/** pdf.js is large; load it only when a sheet is opened. */
async function loadPdf(url: string) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ url, isEvalSupported: false, withCredentials: true }).promise;
  return doc.getPage(1);
}

async function renderTo(url: string, width: number): Promise<HTMLCanvasElement> {
  const page = await loadPdf(url);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
  return canvas;
}

/**
 * Overlay comparison: ink only on the older sheet is red (removed), ink only on the newer sheet is blue (added),
 * ink on both stays grey.
 */
function diff(older: HTMLCanvasElement, newer: HTMLCanvasElement, out: HTMLCanvasElement) {
  out.width = newer.width;
  out.height = newer.height;
  const ctx = out.getContext("2d")!;
  const a = older.getContext("2d")!.getImageData(0, 0, newer.width, newer.height).data;
  const b = newer.getContext("2d")!.getImageData(0, 0, newer.width, newer.height).data;
  const img = ctx.createImageData(newer.width, newer.height);
  const d = img.data;
  let changed = 0;
  for (let i = 0; i < d.length; i += 4) {
    const inkA = a[i + 3]! > 0 && (a[i]! + a[i + 1]! + a[i + 2]!) / 3 < 160;
    const inkB = b[i + 3]! > 0 && (b[i]! + b[i + 1]! + b[i + 2]!) / 3 < 160;
    const [r, g, bl] = inkA && inkB ? [120, 120, 120] : inkA ? [220, 38, 38] : inkB ? [29, 78, 216] : [255, 255, 255];
    if (inkA !== inkB) changed++;
    d[i] = r; d[i + 1] = g; d[i + 2] = bl; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return changed;
}

function cloudPath(x: number, y: number, w: number, h: number) {
  const r = Math.max(6, Math.min(w, h) / 6);
  const arcs = (len: number) => Math.max(1, Math.round(len / (2 * r)));
  let p = `M ${x} ${y}`;
  const edge = (x1: number, y1: number, x2: number, y2: number) => {
    const n = arcs(Math.hypot(x2 - x1, y2 - y1));
    for (let i = 1; i <= n; i++) p += ` A ${r} ${r} 0 0 1 ${x1 + ((x2 - x1) * i) / n} ${y1 + ((y2 - y1) * i) / n}`;
  };
  edge(x, y, x + w, y); edge(x + w, y, x + w, y + h); edge(x + w, y + h, x, y + h); edge(x, y + h, x, y);
  return p;
}

function ShapeSvg({ s, W, H }: { s: Shape; W: number; H: number }) {
  const c = COLORS[s.color];
  const common = { stroke: c, strokeWidth: 2, fill: "none" };
  switch (s.type) {
    case "rect": return <g><rect x={s.x * W} y={s.y * H} width={s.w * W} height={s.h * H} {...common} />{s.label && <text x={s.x * W} y={s.y * H - 4} fill={c} fontSize={13}>{s.label}</text>}</g>;
    case "ellipse": return <g><ellipse cx={(s.x + s.w / 2) * W} cy={(s.y + s.h / 2) * H} rx={(s.w / 2) * W} ry={(s.h / 2) * H} {...common} />{s.label && <text x={s.x * W} y={s.y * H - 4} fill={c} fontSize={13}>{s.label}</text>}</g>;
    case "cloud": return <g><path d={cloudPath(s.x * W, s.y * H, s.w * W, s.h * H)} {...common} />{s.label && <text x={s.x * W} y={s.y * H - 8} fill={c} fontSize={13}>{s.label}</text>}</g>;
    case "arrow": {
      const [x1, y1, x2, y2] = [s.x1 * W, s.y1 * H, s.x2 * W, s.y2 * H];
      const ang = Math.atan2(y2 - y1, x2 - x1), L = 12;
      const head = `${x2},${y2} ${x2 - L * Math.cos(ang - 0.4)},${y2 - L * Math.sin(ang - 0.4)} ${x2 - L * Math.cos(ang + 0.4)},${y2 - L * Math.sin(ang + 0.4)}`;
      return <g><line x1={x1} y1={y1} x2={x2} y2={y2} {...common} /><polygon points={head} fill={c} /></g>;
    }
    case "text": return <text x={s.x * W} y={s.y * H} fill={c} fontSize={14} fontWeight={600}>{s.text}</text>;
    case "pen": return <polyline points={s.points.map(([x, y]) => `${x * W},${y * H}`).join(" ")} {...common} strokeLinejoin="round" strokeLinecap="round" />;
  }
}

export default function SheetViewer({ fileUrl, revisionId, revisions, label }: {
  fileUrl: string; revisionId: string; label: string;
  /** Other revisions of the same sheet, newest first, for comparison. */
  revisions: { id: string; revision: string; fileUrl: string }[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{ W: number; H: number } | null>(null);
  const [compareWith, setCompareWith] = useState("");
  const [changed, setChanged] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("view");
  const [color, setColor] = useState<Color>("red");
  const [mine, setMine] = useState<Shape[]>([]);
  const [published, setPublished] = useState<Layer[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [isPublished, setIsPublished] = useState(false);
  const [canPublish, setCanPublish] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [textAt, setTextAt] = useState<{ x: number; y: number; value: string } | null>(null);

  // Load markup layers.
  useEffect(() => {
    api(`GET`, `/drawing-revisions/${revisionId}/annotations`).then((r) => {
      setMine(r.mine?.shapes ?? []); setIsPublished(!!r.mine?.published_at); setPublished(r.published); setCanPublish(r.canPublish); setDirty(false);
    }).catch((e) => setError(String(e.message ?? e)));
  }, [revisionId]);

  // Render (or compare) whenever the sheet, zoom or comparison changes.
  useEffect(() => {
    let cancelled = false;
    const width = Math.max(320, (box.current?.clientWidth ?? 900) - 4) * zoom;
    (async () => {
      try {
        const current = await renderTo(fileUrl, width);
        let shown = current;
        if (compareWith) {
          const other = revisions.find((r) => r.id === compareWith)!;
          const older = await renderTo(other.fileUrl, width);
          const out = document.createElement("canvas");
          const n = diff(older, current, out);
          shown = out;
          if (!cancelled) setChanged(n);
        } else setChanged(null);
        if (cancelled) return;
        shown.setAttribute("role", "img");
        shown.setAttribute("aria-label", compareWith ? `${label} compared with an earlier revision` : label);
        canvasHost.current!.replaceChildren(shown);
        setSize({ W: shown.width, H: shown.height });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(`This sheet could not be displayed (${(e as Error).message}). Use the download link instead.`);
      }
    })();
    return () => { cancelled = true; };
  }, [fileUrl, zoom, compareWith]);

  const pos = (e: RPointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const start = useRef<{ x: number; y: number } | null>(null);
  const down = (e: RPointerEvent) => {
    if (tool === "view") return;
    const p = pos(e);
    if (tool === "text") { setTextAt({ ...p, value: "" }); return; }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    start.current = p;
    setDraft(tool === "pen" ? { type: "pen", points: [[p.x, p.y]], color } : tool === "arrow" ? { type: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color } : { type: tool, x: p.x, y: p.y, w: 0, h: 0, color });
  };
  const move = (e: RPointerEvent) => {
    if (!draft || !start.current) return;
    const p = pos(e), s = start.current;
    if (draft.type === "pen") setDraft({ ...draft, points: [...draft.points, [p.x, p.y]] });
    else if (draft.type === "arrow") setDraft({ ...draft, x2: p.x, y2: p.y });
    else if (draft.type !== "text") setDraft({ ...draft, x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const up = () => {
    if (!draft) return;
    const tiny = (draft.type === "rect" || draft.type === "cloud" || draft.type === "ellipse") ? draft.w < 0.005 && draft.h < 0.005
      : draft.type === "arrow" ? Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) < 0.005 : draft.type === "pen" ? draft.points.length < 2 : false;
    if (!tiny) { setMine([...mine, draft]); setDirty(true); }
    setDraft(null); start.current = null;
  };

  async function save() {
    try {
      await api("PUT", `/drawing-revisions/${revisionId}/annotations`, { shapes: mine });
      setDirty(false); setStatus(`Saved ${mine.length} markup(s)`);
    } catch (e) { setError((e as Error).message); }
  }
  async function publish(p: boolean) {
    try {
      if (dirty) await save();
      await api("POST", `/drawing-revisions/${revisionId}/annotations/publish`, { published: p });
      setIsPublished(p); setStatus(p ? "Published to the project" : "Unpublished");
    } catch (e) { setError((e as Error).message); }
  }

  const older = revisions.filter((r) => r.id !== revisionId);
  return (
    <section className="card sheet-viewer" aria-label="Sheet viewer">
      <div className="sheet-toolbar" role="toolbar" aria-label="Sheet tools">
        <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out">−</button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => setZoom(1)}>Fit</button>
        <span className="sep" />
        {TOOLS.map(([t, name]) => <button key={t} type="button" aria-pressed={tool === t} className={tool === t ? "active" : ""} onClick={() => setTool(t)} disabled={!!compareWith && t !== "view"}>{name}</button>)}
        <select aria-label="Markup colour" value={color} onChange={(e) => setColor(e.target.value as Color)}>{(Object.keys(COLORS) as Color[]).map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <button type="button" onClick={() => { setMine(mine.slice(0, -1)); setDirty(true); }} disabled={!mine.length}>Undo</button>
        <button type="button" className="primary" onClick={save} disabled={!dirty}>Save markups</button>
        {canPublish && <button type="button" onClick={() => publish(!isPublished)} disabled={!mine.length}>{isPublished ? "Unpublish" : "Publish to project"}</button>}
        <span className="sep" />
        {older.length > 0 && (
          <label>Compare with <select value={compareWith} onChange={(e) => { setCompareWith(e.target.value); setTool("view"); }}>
            <option value="">—</option>{older.map((r) => <option key={r.id} value={r.id}>Rev {r.revision}</option>)}
          </select></label>
        )}
      </div>
      {status && <p className="muted small" role="status">{status}</p>}
      {changed !== null && <p className="small" role="status"><span className="swatch removed" /> removed <span className="swatch added" /> added · {changed === 0 ? "no differences found" : `${changed.toLocaleString()} changed pixels`}</p>}
      <ErrorText error={error} />
      {published.length > 0 && (
        <div className="layers" role="group" aria-label="Published markup layers">
          {published.map((l) => (
            <label key={l.id} className="check"><input type="checkbox" checked={!hidden.has(l.id)} onChange={() => { const h = new Set(hidden); if (h.has(l.id)) h.delete(l.id); else h.add(l.id); setHidden(h); }} /> {l.author_name} ({l.shapes.length})</label>
          ))}
        </div>
      )}
      <div className="sheet-scroll" ref={box}>
        <div className="sheet-stack" style={size ? { width: size.W, height: size.H } : undefined}>
          <div ref={canvasHost} />
          {size && (
            <svg className={`sheet-overlay tool-${tool}`} width={size.W} height={size.H} viewBox={`0 0 ${size.W} ${size.H}`}
              onPointerDown={down} onPointerMove={move} onPointerUp={up} aria-label="Markup layer" role="application">
              {!compareWith && published.filter((l) => !hidden.has(l.id)).flatMap((l) => l.shapes.map((s, i) => <ShapeSvg key={`${l.id}-${i}`} s={s} W={size.W} H={size.H} />))}
              {!compareWith && mine.map((s, i) => <ShapeSvg key={i} s={s} W={size.W} H={size.H} />)}
              {draft && <ShapeSvg s={draft} W={size.W} H={size.H} />}
            </svg>
          )}
          {textAt && size && (
            <form className="sheet-text" style={{ left: textAt.x * size.W, top: textAt.y * size.H }} onSubmit={(e) => {
              e.preventDefault();
              if (textAt.value.trim()) { setMine([...mine, { type: "text", x: textAt.x, y: textAt.y, text: textAt.value.trim(), color }]); setDirty(true); }
              setTextAt(null);
            }}>
              <input autoFocus aria-label="Markup text" value={textAt.value} onChange={(e) => setTextAt({ ...textAt, value: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setTextAt(null)} />
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
