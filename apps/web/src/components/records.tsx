import { useRef, useState, type FormEvent } from "react";
import { api, fmtBytes, fmtDateTime, label, upload } from "../api";
import { useAction, useApi } from "../hooks";
import { ActionButton, Badge, Empty, ErrorText, Field } from "./ui";

export interface Member { id: string; name: string; email: string; role: string; org_role?: string; company?: string | null }

/** Project members as <option>s (internal roles only see the team list). */
export function useMemberOptions(projectId: string | null | undefined, filter?: (m: Member) => boolean) {
  const { data } = useApi<Member[]>(projectId ? `/projects/${projectId}/members` : null);
  const members = (data ?? []).filter(filter ?? (() => true));
  return { members, options: members.map((m) => ({ value: m.id, label: `${m.name}${m.company ? ` (${m.company})` : ""}` })) };
}

export const canWrite = (role?: string) => role === "admin" || role === "manager" || role === "contributor";
export const canManage = (role?: string) => role === "admin" || role === "manager";

export function Comments({ entityType, entityId, projectId }: { entityType: string; entityId: string; projectId: string }) {
  const { data, error, reload } = useApi<any[]>(`/comments?entityType=${entityType}&entityId=${entityId}`);
  const { members } = useMemberOptions(projectId);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const { busy, error: postError, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api("POST", "/comments", { entityType, entityId, body, mentionIds: mentions }))) {
      setBody("");
      setMentions([]);
      reload();
    }
  }

  return (
    <section className="card" aria-label="Comments">
      <h2>Comments</h2>
      <ErrorText error={error} />
      {data && (data.length ? (
        <ul className="list comments">
          {data.map((c) => (
            <li key={c.id}><strong>{c.author_name}</strong> <span className="muted small">{fmtDateTime(c.created_at)}</span><p className="pre">{c.body}</p></li>
          ))}
        </ul>
      ) : <Empty>No comments yet.</Empty>)}
      <form onSubmit={submit} className="stack">
        <Field label="Add a comment"><textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} required /></Field>
        {members.length > 0 && (
          <Field label="Notify (mention)">
            <select multiple size={Math.min(4, members.length)} value={mentions} onChange={(e) => setMentions([...e.target.selectedOptions].map((o) => o.value))}>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
        )}
        <ErrorText error={postError} />
        <div className="actions"><button className="primary" disabled={busy}>Post comment</button></div>
      </form>
    </section>
  );
}

/** Lists attached files and lets permitted users upload + attach (photos from a phone camera work too). */
export function Attachments({ entityType, entityId, projectId, files, onChange, canAdd, title = "Attachments", accept }: {
  entityType: string; entityId: string; projectId: string; files: any[]; onChange: () => void; canAdd: boolean; title?: string; accept?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { busy, error, run } = useAction();
  async function add(fileList: FileList | null) {
    if (!fileList?.length) return;
    await run(async () => {
      for (const f of fileList) {
        const stored = await upload(`/projects/${projectId}/files`, {}, f);
        await api("POST", "/attachments", { entityType, entityId, fileId: stored.id });
      }
    });
    if (input.current) input.current.value = "";
    onChange();
  }
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {files.length ? (
        <ul className="files">
          {files.map((f) => (
            <li key={f.id}>
              {f.mime?.startsWith("image/") && <img src={`/api/files/${f.id}/download?inline=1`} alt={f.name} loading="lazy" />}
              <a href={`/api/files/${f.id}/download`}>{f.name}</a> <span className="muted small">{fmtBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      ) : <Empty>No files attached.</Empty>}
      {canAdd && (
        <label className="upload">
          <span>{busy ? "Uploading…" : "Add files"}</span>
          <input ref={input} type="file" multiple accept={accept} capture={accept?.startsWith("image") ? "environment" : undefined} onChange={(e) => add(e.target.files)} disabled={busy} aria-label={`Add ${title.toLowerCase()}`} />
        </label>
      )}
      <ErrorText error={error} />
    </section>
  );
}

/** Approval route with the current approver's decision buttons. */
export function Approvals({ steps, myId, onDecided, decisions = ["approved", "rejected"] }: {
  steps: any[]; myId: string; onDecided: () => void; decisions?: string[];
}) {
  const [comment, setComment] = useState("");
  if (!steps.length) return null;
  const latest = Math.max(...steps.map((s) => s.round));
  const round = steps.filter((s) => s.round === latest).sort((a, b) => a.seq - b.seq);
  const current = round.find((s) => s.status === "pending");
  const mine = current && current.approver_id === myId ? current : null;
  return (
    <section className="card" aria-label="Approvals">
      <h2>Approval route {latest > 1 && <span className="muted small">(round {latest})</span>}</h2>
      <ol className="steps">
        {round.map((s) => (
          <li key={s.id} className={s === current ? "current" : ""}>
            <strong>{s.approver_name}</strong> <Badge value={s.status} />
            {s.comment && <span className="muted"> — “{s.comment}”</span>}
            {s.decided_at && <span className="muted small"> · {fmtDateTime(s.decided_at)}</span>}
          </li>
        ))}
      </ol>
      {mine && (
        <div className="stack">
          <Field label="Comment (optional)"><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
          <div className="actions">
            {decisions.map((d) => (
              <ActionButton key={d} className={d === "approved" ? "primary" : d === "rejected" ? "danger" : ""}
                onClick={async () => { await api("POST", `/approval-steps/${mine.id}/decide`, { decision: d, comment: comment || undefined }); onDecided(); }}>
                {label(d)}
              </ActionButton>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function CustomFields({ entityType, entityId, editable }: { entityType: string; entityId: string; editable: boolean }) {
  const { data, reload } = useApi<any[]>(`/custom-values/${entityType}/${entityId}`);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  if (!data?.length) return null;
  const val = (f: any) => draft[f.key] ?? f.value ?? "";
  async function save(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api("PUT", `/custom-values/${entityType}/${entityId}`, { values: Object.fromEntries(data!.map((f) => [f.key, val(f)])) }))) {
      setDraft({});
      reload();
    }
  }
  return (
    <form className="card form-grid" onSubmit={save} aria-label="Custom fields">
      <h2 className="span-all">Additional fields</h2>
      {data.map((f) => (
        <Field key={f.id} label={`${f.label}${f.required ? " *" : ""}`}>
          {f.type === "select" ? (
            <select disabled={!editable} value={val(f)} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
              <option value="">—</option>{f.options.map((o: string) => <option key={o}>{o}</option>)}
            </select>
          ) : f.type === "boolean" ? (
            <select disabled={!editable} value={val(f)} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}>
              <option value="">—</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          ) : (
            <input disabled={!editable} type={f.type === "date" ? "date" : "text"} inputMode={f.type === "number" ? "decimal" : undefined} value={val(f)} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
          )}
        </Field>
      ))}
      <ErrorText error={error} />
      {editable && <div className="actions"><button disabled={busy}>Save fields</button></div>}
    </form>
  );
}
