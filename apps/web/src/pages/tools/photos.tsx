import { useState } from "react";
import { api, fmtBytes, fmtDateTime, label } from "../../api";
import { canWrite } from "../../components/records";
import { DataTable, Empty, ErrorText, Form, Loading } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

/** Photo library with albums, tags, captions and capture dates. */
export function PhotoLibrary({ project }: { project: ProjectInfo }) {
  const [filter, setFilter] = useState({ album: "", tag: "", from: "", to: "" });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const photos = useApi<any[]>(`/projects/${project.id}/photos${qs ? `?${qs}` : ""}`);
  const albums = useApi<any[]>(`/projects/${project.id}/photo-albums`);
  const { busy, error, run } = useAction();
  const [newAlbum, setNewAlbum] = useState("");
  const writer = canWrite(project.myRole);
  const albumOptions = (albums.data ?? []).map((a) => ({ value: a.id, label: a.name }));
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Photos</h2>
        {writer && (
          <label className="upload button primary">
            <span>{busy ? "Uploading…" : "Upload photos"}</span>
            <input type="file" accept="image/*" multiple capture="environment" aria-label="Upload photos" disabled={busy}
              onChange={(e) => { const files = e.target.files; if (files?.length) run(async () => { for (const f of files) { const fd = new FormData(); fd.append("file", f, f.name); const res = await fetch(`/api/projects/${project.id}/files`, { method: "POST", headers: { "x-openbuild-csrf": "1" }, body: fd }); if (!res.ok) throw new Error((await res.json()).error); } }).then(photos.reload); }} />
          </label>
        )}
      </div>
      <div className="row filters" role="group" aria-label="Photo filters">
        <label>Album <select aria-label="Filter by album" value={filter.album} onChange={(e) => setFilter({ ...filter, album: e.target.value })}>
          <option value="">All</option><option value="none">Not in an album</option>{albumOptions.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select></label>
        <label>Tag <input aria-label="Filter by tag" value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value.trim().toLowerCase() })} size={10} /></label>
        <label>Taken from <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></label>
        <label>to <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></label>
        {writer && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("POST", `/projects/${project.id}/photo-albums`, { name: newAlbum }); setNewAlbum(""); albums.reload(); }); }}>
            <input aria-label="New album name" placeholder="New album" value={newAlbum} onChange={(e) => setNewAlbum(e.target.value)} required />
            <button type="submit">Add album</button>
          </form>
        )}
      </div>
      <ErrorText error={error ?? photos.error} />
      {!photos.data ? <Loading /> : photos.data.length === 0 ? <Empty>No photos match.</Empty> : (
        <ul className="gallery">
          {photos.data.map((f) => (
            <li key={f.id}>
              <a href={`/api/files/${f.id}/download?inline=1`} target="_blank" rel="noopener"><img src={`/api/files/${f.id}/download?inline=1`} alt={f.caption || f.name} loading="lazy" /></a>
              <div className="small"><strong>{f.caption || f.name}</strong></div>
              <div className="muted small">{f.taken_at ? `Taken ${fmtDateTime(f.taken_at)}` : `Uploaded ${fmtDateTime(f.created_at)}`} · {f.uploaded_by_name} · {fmtBytes(f.size)}</div>
              {(f.album_name || f.location) && <div className="small">{[f.album_name, f.location].filter(Boolean).join(" · ")}</div>}
              {f.tags.length > 0 && <div className="tags">{f.tags.map((t: string) => <button key={t} type="button" className="tag" onClick={() => setFilter({ ...filter, tag: t })}>#{t}</button>)}</div>}
              {f.linked_to && <div className="small">{f.linked_to.map((l: any) => label(l.type)).join(", ")}</div>}
              {writer && (
                <details>
                  <summary>Edit details</summary>
                  <Form ariaLabel={`Details for ${f.name}`} submitLabel="Save" className="flat"
                    initial={{ caption: f.caption ?? "", location: f.location ?? "", tags: f.tags.join(", "), albumId: f.album_id ?? "" }}
                    fields={[
                      { name: "caption", label: "Caption" },
                      { name: "location", label: "Location" },
                      { name: "tags", label: "Tags (comma separated)" },
                      { name: "albumId", label: "Album", type: "select", options: albumOptions },
                    ]}
                    onSubmit={async (v) => {
                      await api("PATCH", `/photos/${f.id}`, { caption: v.caption || null, location: v.location || null, albumId: v.albumId || null, tags: String(v.tags).split(",").map((t) => t.trim()).filter(Boolean) });
                      photos.reload(); albums.reload();
                    }} />
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const SECTIONS: { kind: string; title: string; party?: string; time?: boolean; qty?: boolean }[] = [
  { kind: "delivery", title: "Deliveries", party: "Supplier", time: true },
  { kind: "call", title: "Calls", party: "With", time: true },
  { kind: "safety_violation", title: "Safety violations", party: "Company / person" },
  { kind: "quantity", title: "Quantities installed", qty: true },
  { kind: "waste", title: "Waste removed", party: "Hauler", qty: true },
];

/** Structured daily log sections plus what was recorded elsewhere for the day. */
export function DailyLogSections({ logId, projectId, editable }: { logId: string; projectId: string; editable: boolean }) {
  const s = useApi(`/daily-logs/${logId}/sections`);
  const codes = useApi<any[]>(`/projects/${projectId}/cost-codes`);
  const { error, run } = useAction();
  if (!s.data) return <ErrorText error={s.error} />;
  return (
    <>
      {SECTIONS.map((sec) => {
        const rows = s.data.entries.filter((e: any) => e.kind === sec.kind);
        if (!rows.length && !editable) return null;
        return (
          <section className="card" key={sec.kind} aria-label={sec.title}>
            <h2>{sec.title}</h2>
            <DataTable rows={rows} empty="None recorded." caption={sec.title} columns={[
              ...(sec.time ? [{ label: "Time", render: (e: any) => e.at_time ?? "—" }] : []),
              ...(sec.party ? [{ label: sec.party, render: (e: any) => e.party ?? "—" }] : []),
              { label: "Description", render: (e: any) => e.description },
              ...(sec.qty ? [{ label: "Quantity", render: (e: any) => (e.quantity ? `${e.quantity} ${e.unit ?? ""}` : "—") }, { label: "Cost code", render: (e: any) => e.cost_code ?? "—" }] : []),
              { label: "", render: (e: any) => editable && <button type="button" className="link danger" onClick={() => run(async () => { await api("DELETE", `/daily-log-entries/${e.id}`); s.reload(); })}>Remove</button> },
            ]} />
            {editable && (
              <Form ariaLabel={`Add to ${sec.title}`} submitLabel="Add" resetOnSuccess className="flat"
                fields={[
                  ...(sec.time ? [{ name: "atTime", label: "Time (HH:MM)", placeholder: "07:30" }] : []),
                  ...(sec.party ? [{ name: "party", label: sec.party }] : []),
                  { name: "description", label: "Description", required: true },
                  ...(sec.qty ? [{ name: "quantity", label: "Quantity", required: sec.kind === "quantity" }, { name: "unit", label: "Unit", placeholder: "CY" }, { name: "costCodeId", label: "Cost code", type: "select" as const, options: (codes.data ?? []).map((c) => ({ value: c.id, label: `${c.code} ${c.description}` })) }] : []),
                ]}
                onSubmit={async (v) => {
                  await api("POST", `/daily-logs/${logId}/entries`, { kind: sec.kind, atTime: v.atTime || null, party: v.party || null, description: v.description, quantity: v.quantity || null, unit: v.unit || null, costCodeId: v.costCodeId || null });
                  s.reload();
                }} />
            )}
          </section>
        );
      })}
      <ErrorText error={error} />
      <div className="grid-2">
        <section className="card" aria-label="Equipment on site">
          <h2>Equipment on site</h2>
          <DataTable rows={s.data.equipment.map((e: any) => ({ ...e, id: e.name }))} empty="No equipment hours logged for this date." caption="Equipment hours" columns={[
            { label: "Equipment", render: (e: any) => e.name }, { label: "Operated", render: (e: any) => e.hours_operated }, { label: "Idle", render: (e: any) => e.hours_idle },
          ]} />
        </section>
        <section className="card" aria-label="Time entered">
          <h2>Time entered</h2>
          <DataTable rows={s.data.time.map((t: any) => ({ ...t, id: t.worker }))} empty="No time entered for this date." caption="Time entered" columns={[
            { label: "Worker", render: (t: any) => t.worker }, { label: "Hours", render: (t: any) => t.hours }, { label: "Status", render: (t: any) => label(t.status) },
          ]} />
        </section>
      </div>
    </>
  );
}
