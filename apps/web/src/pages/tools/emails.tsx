import { useState } from "react";
import { api, fmtDateTime, label } from "../../api";
import { canManage, canWrite } from "../../components/records";
import { Badge, Creator, DataTable, ErrorText, Form, Loading } from "../../components/ui";
import { useAction, useApi } from "../../hooks";
import type { ProjectInfo } from "../Project";

const addrs = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

function Compose({ projectId, thread, subject, onSent, onCancel }: { projectId: string; thread?: number; subject?: string; onSent: (r: any) => void; onCancel?: () => void }) {
  const files = useApi<any[]>(`/projects/${projectId}/files`);
  return (
    <Form ariaLabel={thread ? "Reply" : "New email"} submitLabel="Send" onCancel={onCancel} initial={{ subject: subject ?? "", fileIds: [] }}
      fields={[
        { name: "to", label: "To (comma separated)", required: true, full: true },
        { name: "cc", label: "Cc", full: true },
        ...(thread ? [] : [{ name: "subject", label: "Subject", required: true, full: true }]),
        { name: "body", label: "Message", type: "textarea" as const, required: true, full: true },
        { name: "fileIds", label: "Attach project files (Ctrl/Cmd-click)", type: "multiselect" as const, options: (files.data ?? []).map((f) => ({ value: f.id, label: f.name })) },
      ]}
      onSubmit={async (v) => onSent(await api("POST", `/projects/${projectId}/emails`, { to: addrs(v.to), cc: addrs(v.cc ?? ""), subject: thread ? subject : v.subject, body: v.body, fileIds: v.fileIds ?? [], ...(thread ? { thread } : {}) }))} />
  );
}

export function EmailsTool({ project }: { project: ProjectInfo }) {
  const list = useApi<any[]>(`/projects/${project.id}/emails`);
  const [open, setOpen] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [inbound, setInbound] = useState<string | null>(null);
  const { error, run } = useAction();
  return (
    <>
      <div className="tool-bar">
        <h2 className="tool-title">Emails</h2>
        {canWrite(project.myRole) && (
          <Creator label="New email">
            {(close) => <Compose projectId={project.id} onCancel={close} onSent={(r) => { close(); setStatus(r.status === "sent" ? "Email sent." : r.status === "logged" ? "No mail server is configured, so the email was saved to the log only." : `Sending failed: ${r.error}`); list.reload(); setOpen(r.thread); }} />}
          </Creator>
        )}
        {canManage(project.myRole) && <button type="button" onClick={() => run(async () => { const r = await api("POST", `/projects/${project.id}/emails/inbound-token`); setInbound(`${location.origin}${r.path}`); })}>Set up inbound email</button>}
      </div>
      {status && <p className="notice" role="status">{status}</p>}
      {inbound && <div className="notice" role="status">Point your mail provider's inbound webhook at this URL (shown once; setting up again replaces it). It accepts JSON {"{"} from, to, cc, subject, text {"}"}: <input readOnly aria-label="Inbound email URL" value={inbound} onFocus={(e) => e.target.select()} /></div>}
      <ErrorText error={error ?? list.error} />
      <section className="card">
        <DataTable rows={list.data?.map((t) => ({ ...t, id: String(t.thread_number) })) ?? null} empty="No emails yet." caption="Email threads" columns={[
          { label: "Subject", render: (t: any) => <button type="button" className="link" onClick={() => setOpen(t.thread_number)}>{t.subject}</button> },
          { label: "Last from", render: (t: any) => t.from_address }, { label: "Messages", render: (t: any) => t.messages },
          { label: "Last", render: (t: any) => fmtDateTime(t.created_at) }, { label: "Status", render: (t: any) => <Badge value={t.status} /> },
        ]} />
      </section>
      {open && <Thread projectId={project.id} n={open} canReply={canWrite(project.myRole)} onChange={list.reload} />}
    </>
  );
}

function Thread({ projectId, n, canReply, onChange }: { projectId: string; n: number; canReply: boolean; onChange: () => void }) {
  const t = useApi(`/projects/${projectId}/emails/${n}`);
  const [replying, setReplying] = useState(false);
  if (!t.data) return <Loading />;
  const first = t.data.messages[0];
  return (
    <section className="card" aria-label="Email thread">
      <h2>{first.subject}</h2>
      {t.data.messages.map((m: any) => (
        <article key={m.id} className="email">
          <div className="small"><strong>{m.direction === "inbound" ? m.from_address : `${m.sent_by_name ?? m.from_address}`}</strong> → {m.to_addresses.join(", ") || "project"}{m.cc_addresses.length ? ` (cc ${m.cc_addresses.join(", ")})` : ""} · {fmtDateTime(m.created_at)} · <Badge value={m.status} />{m.error && <span className="danger"> {m.error}</span>}</div>
          <p className="pre">{m.body}</p>
          {m.files.length > 0 && <div className="small">Attachments: {m.files.map((f: any) => <a key={f.id} href={`/api/files/${f.id}/download`}>{f.name} </a>)}</div>}
          <div className="muted small">{label(m.direction)}</div>
        </article>
      ))}
      {canReply && (replying
        ? <Compose projectId={projectId} thread={n} subject={first.subject} onCancel={() => setReplying(false)} onSent={() => { setReplying(false); t.reload(); onChange(); }} />
        : <button type="button" onClick={() => setReplying(true)}>Reply</button>)}
    </section>
  );
}
