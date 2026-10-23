import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { ErrorText } from "./ui";

type Mode = "scale" | "length" | "area" | "count";
type Pt = [number, number];
interface Item { id: string; name: string; kind: "length" | "area" | "count"; points: Pt[]; quantity: string; unit: string }

/**
 * Quantity takeoff layer for the sheet viewer: calibrate with two clicks and a known distance, then click out lengths,
 * areas and counts. Coordinates are sheet fractions, so they hold at any zoom.
 */
export function TakeoffLayer({ revisionId, W, H, canMeasure, active, onActive, barHost }: { revisionId: string; W: number; H: number; canMeasure: boolean; active: boolean; onActive: (on: boolean) => void; barHost: HTMLElement | null }) {
  const [data, setData] = useState<{ scale: { unit: string } | null; items: Item[] } | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [pts, setPts] = useState<Pt[]>([]);
  const [name, setName] = useState("");
  const [dist, setDist] = useState({ value: "", unit: "ft" });
  const [error, setError] = useState<string | null>(null);
  const load = () => api(`GET`, `/drawing-revisions/${revisionId}/takeoff`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [revisionId]);
  const pick = (m: Mode) => { setMode(m); setPts([]); setName(""); onActive(true); };
  const stop = () => { setMode(null); setPts([]); onActive(false); };
  const done = mode === "scale" ? pts.length === 2 : mode === "length" ? pts.length >= 2 : mode === "area" ? pts.length >= 3 : mode === "count" ? pts.length >= 1 : false;
  async function save() {
    try {
      if (mode === "scale") await api("PUT", `/drawing-revisions/${revisionId}/takeoff/scale`, { a: pts[0], b: pts[1], distance: Number(dist.value), unit: dist.unit, aspect: W / H });
      else await api("POST", `/drawing-revisions/${revisionId}/takeoff`, { name, kind: mode, points: pts });
      setError(null); stop(); load();
    } catch (e) { setError((e as Error).message); }
  }
  const xy = (p: Pt) => `${p[0] * W},${p[1] * H}`;
  return (
    <>
      {barHost && createPortal(<>
      <div className="takeoff-bar" role="toolbar" aria-label="Takeoff tools">
        <strong>Takeoff</strong>
        <span className="muted small">{data?.scale ? `Scale set (${data.scale.unit})` : "No scale yet"}</span>
        {canMeasure && (["scale", "length", "area", "count"] as Mode[]).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? "active" : ""} disabled={m !== "scale" && m !== "count" && !data?.scale} onClick={() => pick(m)}>
            {m === "scale" ? "Set scale" : m === "length" ? "Measure length" : m === "area" ? "Measure area" : "Count"}
          </button>
        ))}
        {mode && <span className="small">{mode === "scale" ? "Click two points a known distance apart." : mode === "count" ? "Click each item." : "Click the points, then save."} ({pts.length} point(s))</span>}
        {mode && done && mode === "scale" && <>
          <input aria-label="Known distance" inputMode="decimal" size={6} value={dist.value} onChange={(e) => setDist({ ...dist, value: e.target.value })} placeholder="30" />
          <select aria-label="Distance unit" value={dist.unit} onChange={(e) => setDist({ ...dist, unit: e.target.value })}><option value="ft">ft</option><option value="m">m</option></select>
        </>}
        {mode && done && mode !== "scale" && <input aria-label="Measurement name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Partition wall" />}
        {mode && <><button type="button" className="primary" disabled={!done || (mode === "scale" ? !(Number(dist.value) > 0) : !name.trim())} onClick={save}>Save measurement</button><button type="button" onClick={stop}>Cancel</button></>}
      </div>
      <ErrorText error={error} />
      </>, barHost)}
      <svg className={`takeoff-overlay ${active ? "on" : ""}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="application" aria-label="Takeoff layer"
        onClick={(e) => {
          if (!mode) return;
          const r = (e.currentTarget as SVGElement).getBoundingClientRect();
          const p: Pt = [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
          setPts(mode === "scale" && pts.length === 2 ? [p] : [...pts, p]);
        }}>
        {data?.items.map((it) => {
          const c = it.kind === "area" ? "#15803d" : it.kind === "length" ? "#7c3aed" : "#0e7490";
          const at = it.points[0]!;
          return (
            <g key={it.id}>
              {it.kind === "length" && <polyline points={it.points.map(xy).join(" ")} fill="none" stroke={c} strokeWidth={3} />}
              {it.kind === "area" && <polygon points={it.points.map(xy).join(" ")} fill={c} fillOpacity={0.15} stroke={c} strokeWidth={2} />}
              {it.kind === "count" && it.points.map((p, i) => <circle key={i} cx={p[0] * W} cy={p[1] * H} r={7} fill={c} fillOpacity={0.5} />)}
              <text x={at[0] * W + 6} y={at[1] * H - 6} fill={c} fontSize={13} fontWeight={600}>{it.name}: {Number(it.quantity).toLocaleString()} {it.unit}</text>
            </g>
          );
        })}
        {pts.length > 0 && (mode === "area" ? <polygon points={pts.map(xy).join(" ")} fill="#f59e0b" fillOpacity={0.2} stroke="#f59e0b" strokeWidth={2} /> : <polyline points={pts.map(xy).join(" ")} fill="none" stroke="#f59e0b" strokeWidth={2} strokeDasharray="6 3" />)}
        {pts.map((p, i) => <circle key={i} cx={p[0] * W} cy={p[1] * H} r={4} fill="#f59e0b" />)}
      </svg>
    </>
  );
}
