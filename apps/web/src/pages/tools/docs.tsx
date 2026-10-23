import { lazy, Suspense, useState } from "react";
import { api, fmtBytes, fmtDate, fmtDateTime, upload } from "../../api";
import { Approvals, Comments, canWrite, useMemberOptions } from "../../components/records";
import { Badge, Creator, DataTable, ErrorText, Form, Link, Loading, PageHead } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

// ---------------- Drawings ----------------

export function DrawingsTool({ project }: { project: ProjectInfo }) {
  const [discipline, setDiscipline] = useState("");
  const list = useApi<any[]>(`/projects/${project.id}/drawings${discipline ? `?discipline=${encodeURIComponent(discipline)}` : ""}`);
  const all = useApi<any[]>(`/projects/${project.id}/drawings`);
  const disciplines = [...new Set((all.data ?? []).map((d) => d.discipline))];
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Drawings</h2>
        {canWrite(project.myRole) && (
          <Creator label="Upload sheet">
            {(close) => (
              <Form ariaLabel="Upload drawing" submitLabel="Upload" onCancel={close}
                fields={[
                  { name: "number", label: "Sheet number", required: true, placeholder: "A-101" },
                  { name: "title", label: "Sheet title (new sheets)" , placeholder: "Ground floor plan" },
                  { name: "discipline", label: "Discipline", placeholder: "Architectural" },
                  { name: "revision", label: "Revision", required: true, placeholder: "0" },
                  { name: "setName", label: "Drawing set", placeholder: "Issued for construction" },
                  { name: "issuedDate", label: "Issued date", type: "date" },
                  { name: "file", label: "PDF", type: "file", accept: "application/pdf", required: true, full: true },
                ]}
                onSubmit={async (v) => {
                  await upload(`/projects/${project.id}/drawings`, { number: v.number, title: v.title, discipline: v.discipline || undefined, revision: v.revision, setName: v.setName, issuedDate: v.issuedDate }, v.file);
                  close(); list.reload(); all.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      {disciplines.length > 1 && (
        <div className="filters">
          <label>Discipline <select value={discipline} onChange={(e) => setDiscipline(e.target.value)}><option value="">All</option>{disciplines.map((d) => <option key={d}>{d}</option>)}</select></label>
        </div>
      )}
      <section className="card">
        <ErrorText error={list.error} />
        <DataTable rows={list.data} href={(d) => `/drawings/${d.id}`} empty="No drawings uploaded yet." caption="Drawings" columns={[
          { label: "Sheet", render: (d) => d.number },
          { label: "Title", render: (d) => d.title },
          { label: "Discipline", render: (d) => d.discipline },
          { label: "Current rev", render: (d) => d.current_revision },
          { label: "Set", render: (d) => d.set_name ?? "—" },
          { label: "Issued", render: (d) => fmtDate(d.issued_date) },
          { label: "Revisions", render: (d) => d.revision_count },
        ]} />
      </section>
    </>
  );
}

const SheetViewer = lazy(() => import("../../components/SheetViewer"));

export function DrawingPage({ id }: { id: string }) {
  const d = useApi(`/drawings/${id}`);
  const [toolLink, setToolLink] = useState<{ downloadUrl: string; uploadUrl: string; launchUrl: string | null } | null>(null);
  const { run, error } = useAction();
  if (d.error) return <ErrorText error={d.error} />;
  const dr = d.data;
  if (!dr) return <Loading />;
  const current = dr.revisions[0];
  const writable = canWrite(dr.myRole);
  return (
    <>
      <PageHead back={{ to: `/projects/${dr.project_id}/drawings`, label: "Drawings" }} title={`${dr.number} — ${dr.title}`} sub={`${dr.discipline} · current revision ${current?.revision ?? "—"}`} />
      {current && (
        <Suspense fallback={<section className="card"><Loading /></section>}>
          <SheetViewer key={current.id} revisionId={current.id} label={`Sheet ${dr.number} revision ${current.revision}`}
            fileUrl={`/api/files/${current.file_id}/download?inline=1`}
            revisions={dr.revisions.map((r: any) => ({ id: r.id, revision: r.revision, fileUrl: `/api/files/${r.file_id}/download?inline=1` }))} />
          <p className="muted small"><a href={`/api/files/${current.file_id}/download`}>Download the PDF</a></p>
        </Suspense>
      )}
      {writable && current && (
        <section className="card">
          <h2>Mark up</h2>
          <p className="muted">Open this revision in a markup tool, then save the marked-up PDF back. The issued sheet itself never changes.</p>
          <div className="actions left wrap">
            {dr.tools.map((t: { id: string; name: string }) => (
              <button key={t.id} onClick={() => run(async () => {
                const s = await api("POST", `/drawing-revisions/${current.id}/tool-session`, { tool: t.id });
                setToolLink(s);
                if (s.launchUrl) window.open(s.launchUrl, "_blank", "noopener");
              })}>Open in {t.name}</button>
            ))}
          </div>
          {toolLink && !toolLink.launchUrl && (
            <p className="notice">
              <a href={toolLink.downloadUrl}>Download the sheet</a>, mark it up, then upload the saved PDF below (or let the tool POST it to the upload link, valid 2 hours).
            </p>
          )}
          <ErrorText error={error} />
          <MarkupUpload revisionId={current.id} onDone={d.reload} />
        </section>
      )}
      <section className="card">
        <h2>Revision history</h2>
        <DataTable rows={dr.revisions} caption="Revisions" columns={[
          { label: "Revision", render: (r: any) => <a href={`/api/files/${r.file_id}/download`}>Rev {r.revision}</a> },
          { label: "Set", render: (r: any) => r.set_name ?? "—" },
          { label: "Issued", render: (r: any) => fmtDate(r.issued_date) },
          { label: "Uploaded", render: (r: any) => `${fmtDateTime(r.created_at)} by ${r.uploaded_by_name ?? "—"}` },
          { label: "Markups", render: (r: any) => r.markups.length ? r.markups.map((m: any) => <div key={m.id}><a href={`/api/files/${m.file_id}/download`}>{m.tool}</a> <span className="muted small">{m.by} · {m.note ?? ""}</span></div>) : "—" },
        ]} />
      </section>
      {dr.rfis.length > 0 && (
        <section className="card">
          <h2>RFIs on this sheet</h2>
          <ul className="list">{dr.rfis.map((r: any) => <li key={r.id}><Link to={`/rfis/${r.id}`}>RFI #{r.number}: {r.subject}</Link> <Badge value={r.status} /></li>)}</ul>
        </section>
      )}
      <Comments entityType="drawing" entityId={dr.id} projectId={dr.project_id} />
    </>
  );
}

function MarkupUpload({ revisionId, onDone }: { revisionId: string; onDone: () => void }) {
  return (
    <Form ariaLabel="Upload markup" submitLabel="Upload markup" resetOnSuccess className="flat"
      fields={[
        { name: "file", label: "Marked-up PDF", type: "file", accept: "application/pdf", required: true },
        { name: "tool", label: "Tool", type: "select", required: true, options: [{ value: "opendraft", label: "OpenDraft" }, { value: "acrobat-alt", label: "Acrobat alternative" }, { value: "manual", label: "Other" }] },
        { name: "note", label: "Note" },
      ]}
      initial={{ tool: "opendraft" }}
      onSubmit={async (v) => { await upload(`/drawing-revisions/${revisionId}/markups`, { tool: v.tool, note: v.note }, v.file); onDone(); }} />
  );
}

// ---------------- Documents ----------------

export function DocumentsTool({ project }: { project: ProjectInfo }) {
  const [folder, setFolder] = useState<{ id: string; name: string } | null>(null);
  const folders = useApi<any[]>(`/projects/${project.id}/folders`);
  const docs = useApi<any[]>(`/projects/${project.id}/documents${folder ? `?folderId=${folder.id}` : ""}`);
  const writable = canWrite(project.myRole);
  const children = (folders.data ?? []).filter((f) => f.parent_id === (folder?.id ?? null));
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Documents</h2>
        <div className="actions">
          {writable && (
            <Creator label="New folder">
              {(close) => (
                <Form ariaLabel="New folder" submitLabel="Create folder" onCancel={close} className="compact"
                  fields={[{ name: "name", label: "Folder name", required: true }]}
                  onSubmit={async (v) => { await api("POST", `/projects/${project.id}/folders`, { name: v.name, parentId: folder?.id ?? null }); close(); folders.reload(); }} />
              )}
            </Creator>
          )}
          {writable && (
            <Creator label="Upload document">
              {(close) => (
                <Form ariaLabel="Upload document" submitLabel="Upload" onCancel={close}
                  fields={[{ name: "file", label: "File", type: "file", required: true }, { name: "name", label: "Name (optional)" }, { name: "note", label: "Version note" }]}
                  onSubmit={async (v) => { await upload(`/projects/${project.id}/documents`, { name: v.name, note: v.note, folderId: folder?.id }, v.file); close(); docs.reload(); }} />
              )}
            </Creator>
          )}
        </div>
      </div>
      <nav className="crumbs" aria-label="Folder path">
        <button className="link" onClick={() => setFolder(null)}>All documents</button>
        {folder && <> / <strong>{folder.name}</strong></>}
      </nav>
      <section className="card">
        {children.length > 0 && (
          <ul className="folders">{children.map((f) => <li key={f.id}><button className="link" onClick={() => setFolder(f)}>📁 {f.name}</button></li>)}</ul>
        )}
        <DataTable rows={docs.data} href={(d) => `/documents/${d.id}`} empty={children.length ? "No documents in this folder." : "No documents yet."} caption="Documents" columns={[
          { label: "Name", render: (d) => d.name },
          { label: "Version", render: (d) => `v${d.version}` },
          { label: "Status", render: (d) => <Badge value={d.status} /> },
          { label: "Updated", render: (d) => `${fmtDate(d.updated_at)} · ${d.updated_by_name ?? ""}` },
        ]} />
      </section>
    </>
  );
}

export function DocumentPage({ id }: { id: string }) {
  const d = useApi(`/documents/${id}`);
  const { options } = useMemberOptions(d.data?.project_id);
  if (d.error) return <ErrorText error={d.error} />;
  const doc = d.data;
  if (!doc) return <Loading />;
  const writable = canWrite(doc.myRole);
  return (
    <>
      <PageHead back={{ to: `/projects/${doc.project_id}/documents`, label: "Documents" }} title={<>{doc.name} <Badge value={doc.status} /></>} sub={`Version ${doc.versions[0]?.version}`} />
      <section className="card">
        <h2>Versions</h2>
        <DataTable rows={doc.versions} caption="Versions" columns={[
          { label: "Version", render: (v: any) => <a href={`/api/files/${v.file_id}/download`}>v{v.version} — {v.file_name}</a> },
          { label: "Size", render: (v: any) => fmtBytes(v.size) },
          { label: "Note", render: (v: any) => v.note ?? "—" },
          { label: "By", render: (v: any) => `${v.created_by_name ?? "—"}, ${fmtDateTime(v.created_at)}` },
        ]} />
      </section>
      {writable && (
        <div className="grid-2">
          <Form ariaLabel="Upload new version" submitLabel="Upload new version" resetOnSuccess
            fields={[{ name: "file", label: "New version", type: "file", required: true }, { name: "note", label: "What changed" }]}
            onSubmit={async (v) => { await upload(`/documents/${doc.id}/versions`, { note: v.note }, v.file); d.reload(); }} />
          {doc.status !== "in_review" && (
            <Form ariaLabel="Submit for approval" submitLabel="Submit for approval"
              fields={[
                { name: "first", label: "First approver", type: "select", required: true, options },
                { name: "second", label: "Second approver (optional)", type: "select", options },
              ]}
              onSubmit={async (v) => { await api("POST", `/documents/${doc.id}/submit`, { approverIds: [v.first, v.second].filter(Boolean) }); d.reload(); }} />
          )}
        </div>
      )}
      <Approvals steps={doc.approvals} myId={doc.myId} onDecided={d.reload} />
      <Comments entityType="document" entityId={doc.id} projectId={doc.project_id} />
    </>
  );
}

// ---------------- Specifications ----------------

export function SpecsTool({ project }: { project: ProjectInfo }) {
  const specs = useApi<any[]>(`/projects/${project.id}/specs`);
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Specifications</h2>
        {canWrite(project.myRole) && (
          <Creator label="Add section">
            {(close) => (
              <Form ariaLabel="Add spec section" submitLabel="Add section" onCancel={close}
                fields={[
                  { name: "number", label: "Section number", required: true, placeholder: "03 30 00" },
                  { name: "title", label: "Title", required: true, placeholder: "Cast-in-place concrete" },
                  { name: "file", label: "Section PDF (optional)", type: "file", accept: "application/pdf" },
                ]}
                onSubmit={async (v) => {
                  if (v.file) await upload(`/projects/${project.id}/specs`, { number: v.number, title: v.title }, v.file);
                  else await api("POST", `/projects/${project.id}/specs`, { number: v.number, title: v.title });
                  close(); specs.reload();
                }} />
            )}
          </Creator>
        )}
      </div>
      <section className="card">
        <ErrorText error={specs.error} />
        <DataTable rows={specs.data} empty="No specification sections yet." caption="Specifications" columns={[
          { label: "Section", render: (s) => s.number },
          { label: "Title", render: (s) => s.file_id ? <a href={`/api/files/${s.file_id}/download?inline=1`} target="_blank" rel="noopener">{s.title}</a> : s.title },
          { label: "Submittals", render: (s) => s.submittal_count },
        ]} />
      </section>
    </>
  );
}
