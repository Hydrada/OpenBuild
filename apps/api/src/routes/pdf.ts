import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../app.js";
import { requireUser } from "../app.js";
import { HttpError } from "../lib/errors.js";
import { PdfDoc } from "../lib/pdf.js";

type J = Record<string, any>;
const d = (v: unknown) => (v ? String(v).slice(0, 10) : "-");
const dt = (v: unknown) => (v ? String(v).slice(0, 16).replace("T", " ") : "-");
const lbl = (v: unknown) => (v ? String(v).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "-");
const money = (v: unknown) => (v === null || v === undefined || v === "" ? "" : Number(v) < 0 ? `-$${String(v).slice(1).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : `$${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);

/**
 * PDF exports. Each one fetches the record through the normal JSON endpoint *as the caller* (same cookie or API key),
 * so the PDF can never show more than the caller could already see.
 */
export const pdfRoutes = (_config: AppConfig): FastifyPluginAsync => async (app) => {
  async function asCaller(req: FastifyRequest, url: string): Promise<J> {
    const res = await (app as FastifyInstance).inject({
      method: "GET", url,
      headers: { ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
    });
    if (res.statusCode !== 200) {
      let msg = "Not found";
      try { msg = res.json().error ?? msg; } catch { /* keep default */ }
      throw new HttpError(res.statusCode, msg);
    }
    return res.json();
  }

  async function projectName(req: FastifyRequest, projectId: string) {
    const p = await asCaller(req, `/api/projects/${projectId}`);
    return `${p.name}${p.code ? ` (#${p.code})` : ""}`;
  }

  async function send(reply: FastifyReply, doc: PdfDoc, filename: string) {
    const bytes = await doc.bytes();
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${filename.replace(/[^\w.-]+/g, "_")}"`);
    reply.header("Cache-Control", "private, max-age=0");
    return reply.send(Buffer.from(bytes));
  }

  type Id = { Params: { id: string } };

  app.get<Id>("/rfis/:id/pdf", async (req, reply) => {
    requireUser(req);
    const r = await asCaller(req, `/api/rfis/${req.params.id}`);
    const doc = await PdfDoc.create(`RFI #${r.number}: ${r.subject}`, await projectName(req, r.project_id));
    doc.fields([
      ["Status", lbl(r.status)], ["Assigned to", r.assignee_name], ["Created by", r.created_by_name], ["Created", dt(r.created_at)],
      ["Due", d(r.due_date)], ["Drawing", r.drawing_number], ["Spec section", r.spec_number ? `${r.spec_number} ${r.spec_title ?? ""}` : null],
      ["Cost impact", lbl(r.cost_impact)], ["Schedule impact", lbl(r.schedule_impact)],
    ]);
    doc.heading("Question").paragraph(r.question);
    doc.heading("Responses");
    if (!r.responses.length) doc.paragraph("No responses yet.");
    for (const x of r.responses) doc.fields([[`${x.is_official ? "Official answer" : "Response"}`, `${x.author_name ?? "-"}, ${dt(x.created_at)}`]]).paragraph(x.body);
    if (r.attachments.length) doc.heading("Attachments").paragraph(r.attachments.map((a: J) => a.name).join("\n"));
    return send(reply, doc, `RFI-${r.number}.pdf`);
  });

  app.get<Id>("/submittals/:id/pdf", async (req, reply) => {
    requireUser(req);
    const s = await asCaller(req, `/api/submittals/${req.params.id}`);
    const doc = await PdfDoc.create(`Submittal #${s.number} rev ${s.revision}: ${s.title}`, await projectName(req, s.project_id));
    doc.fields([
      ["Type", lbl(s.type)], ["Status", lbl(s.status)], ["Spec section", s.spec_number ? `${s.spec_number} ${s.spec_title ?? ""}` : null],
      ["Due", d(s.due_date)], ["Submitted by", s.created_by_name], ["Created", dt(s.created_at)],
    ]);
    doc.heading("Review");
    doc.table([{ label: "Reviewer", width: 0.3 }, { label: "Decision", width: 0.2 }, { label: "Decided", width: 0.18 }, { label: "Comment", width: 0.32 }],
      (s.approvals ?? s.steps ?? []).map((a: J) => [a.approver_name ?? a.name, lbl(a.status), dt(a.decided_at), a.comment ?? ""]));
    if (s.attachments?.length) doc.heading("Attachments").paragraph(s.attachments.map((f: J) => f.name).join("\n"));
    return send(reply, doc, `Submittal-${s.number}-rev${s.revision}.pdf`);
  });

  app.get<Id>("/daily-logs/:id/pdf", async (req, reply) => {
    requireUser(req);
    const l = await asCaller(req, `/api/daily-logs/${req.params.id}`);
    const doc = await PdfDoc.create(`Daily log ${d(l.log_date)}`, await projectName(req, l.project_id));
    doc.fields([
      ["Weather", l.weather], ["Temperature", l.temp_low !== null || l.temp_high !== null ? `${l.temp_low ?? "-"} / ${l.temp_high ?? "-"}` : null],
      ["Status", l.status === "signed" ? `Signed by ${l.signed_by_name ?? "-"} ${dt(l.signed_at)}` : lbl(l.status)], ["Created by", l.created_by_name],
    ]);
    doc.heading("Manpower");
    const totalWorkers = l.manpower.reduce((a: number, m: J) => a + Number(m.workers), 0);
    const totalHours = l.manpower.reduce((a: number, m: J) => a + Number(m.hours), 0);
    doc.table([{ label: "Company", width: 0.32 }, { label: "Trade", width: 0.22 }, { label: "Workers", width: 0.12, align: "right" }, { label: "Hours", width: 0.12, align: "right" }, { label: "Notes", width: 0.22 }],
      [...l.manpower.map((m: J) => [m.company, m.trade ?? "", m.workers, m.hours, m.notes ?? ""]), ["Total", "", totalWorkers, totalHours.toFixed(2), ""]], { boldLast: true });
    doc.heading("Work performed").paragraph(l.work_performed);
    doc.heading("Delays").paragraph(l.delays);
    doc.heading("Visitors").paragraph(l.visitors);
    doc.heading("Notes").paragraph(l.notes);
    if (l.photos?.length) doc.heading("Photos").paragraph(l.photos.map((p: J) => p.name).join("\n"));
    return send(reply, doc, `Daily-log-${d(l.log_date)}.pdf`);
  });

  app.get<Id>("/meetings/:id/pdf", async (req, reply) => {
    requireUser(req);
    const m = await asCaller(req, `/api/meetings/${req.params.id}`);
    const doc = await PdfDoc.create(`${m.status === "minutes_published" ? "Minutes" : "Agenda"}: ${m.title}`, await projectName(req, m.project_id));
    doc.fields([["When", dt(m.starts_at)], ["Location", m.location], ["Attendees", m.attendees.map((a: J) => a.name).join(", ") || "-"], ["Status", lbl(m.status)]]);
    doc.table([{ label: "#", width: 0.05 }, { label: "Topic", width: 0.25 }, { label: "Notes", width: 0.38 }, { label: "Action by", width: 0.14 }, { label: "Due", width: 0.1 }, { label: "Status", width: 0.08 }],
      m.items.map((i: J) => [i.seq, i.topic, i.notes ?? "", i.assignee_name ?? "", i.due_date ? d(i.due_date) : "", i.assignee_id ? lbl(i.status) : ""]));
    return send(reply, doc, `Meeting-${d(m.starts_at)}.pdf`);
  });

  app.get<Id>("/change-orders/:id/pdf", async (req, reply) => {
    requireUser(req);
    const c = await asCaller(req, `/api/change-orders/${req.params.id}`);
    const doc = await PdfDoc.create(`Change order #${c.number}: ${c.title}`, await projectName(req, c.project_id));
    doc.fields([
      ["Contract", `#${c.contract.number} ${c.contract.title} (${lbl(c.contract.kind)})`], ["Counterparty", c.contract.counterparty],
      ["Status", lbl(c.status)], ["Schedule impact", `${c.schedule_impact_days ?? 0} day(s)`], ["Created", dt(c.created_at)],
    ]);
    if (c.description) doc.heading("Description").paragraph(c.description);
    doc.table([{ label: "Cost code", width: 0.18 }, { label: "Description", width: 0.6 }, { label: "Amount", width: 0.22, align: "right" }],
      [...c.lines.map((l: J) => [l.cost_code, l.description, money(l.amount)]), ["", "Total", money(c.total)]], { boldLast: true });
    if (c.approvals?.length) {
      doc.heading("Approvals");
      doc.table([{ label: "Approver", width: 0.35 }, { label: "Decision", width: 0.2 }, { label: "Decided", width: 0.2 }, { label: "Comment", width: 0.25 }],
        c.approvals.map((a: J) => [a.approver_name ?? a.name, lbl(a.status), dt(a.decided_at), a.comment ?? ""]));
    }
    doc.signatures(["Owner", "Architect", "Contractor"]);
    return send(reply, doc, `Change-order-${c.number}.pdf`);
  });

  app.get<Id>("/tm-tickets/:id/pdf", async (req, reply) => {
    requireUser(req);
    const t = await asCaller(req, `/api/tm-tickets/${req.params.id}`);
    const doc = await PdfDoc.create(`T&M ticket #${t.number}`, await projectName(req, t.project_id));
    doc.fields([["Work date", d(t.work_date)], ["Performed by", t.company], ["Status", lbl(t.status)], ["Signed in the field by", t.signed_by ? `${t.signed_by}, ${dt(t.signed_at)}` : "Not signed"]]);
    doc.heading("Work performed").paragraph(t.description);
    doc.table([{ label: "Type", width: 0.12 }, { label: "Description", width: 0.36 }, { label: "Qty", width: 0.12, align: "right" }, { label: "Rate", width: 0.13, align: "right" }, { label: "Cost code", width: 0.12 }, { label: "Amount", width: 0.15, align: "right" }],
      [...t.lines.map((l: J) => [lbl(l.category), l.description, `${l.quantity}${l.unit ? ` ${l.unit}` : ""}`, money(l.rate), l.cost_code ?? "", money(l.amount)]), ["", "Total", "", "", "", money(t.total)]], { boldLast: true });
    doc.signatures(["Owner's representative", "Contractor"]);
    return send(reply, doc, `TM-ticket-${t.number}.pdf`);
  });

  /** AIA G702 summary and G703 continuation sheet. */
  app.get<Id>("/invoices/:id/pdf", async (req, reply) => {
    requireUser(req);
    const pa = await asCaller(req, `/api/invoices/${req.params.id}`);
    const inv = pa.invoice, k = pa.contract, t = pa.totals;
    const doc = await PdfDoc.create(`Application for payment #${inv.number}`, `${await projectName(req, inv.project_id)} - contract #${k.number} ${k.title}`);
    doc.fields([["Contractor / vendor", k.counterparty], ["Period", `${d(inv.period_start)} to ${d(inv.period_end)}`], ["Status", lbl(inv.status)], ["Retainage", `${pa.retainage_percent}%`]]);
    doc.heading("Summary (G702)");
    doc.table([{ label: "", width: 0.7 }, { label: "", width: 0.3, align: "right" }], [
      ["1. Original contract sum", money(t.original_contract_sum)],
      ["2. Net change by change orders", money(t.net_change_by_change_orders)],
      ["3. Contract sum to date (1 + 2)", money(t.contract_sum_to_date)],
      ["4. Total completed and stored to date", money(t.completed_to_date)],
      ["5. Retainage", money(t.retainage)],
      ["6. Total earned less retainage (4 - 5)", money(t.earned_less_retainage)],
      ["7. Less previous certificates for payment", money(t.previous_certificates)],
      ["8. Current payment due (6 - 7)", money(t.current_payment_due)],
      ["9. Balance to finish, including retainage", money(t.balance_to_finish_including_retainage)],
    ], { size: 10 });
    doc.heading("Continuation sheet (G703)");
    doc.table([
      { label: "Cost code", width: 0.08 }, { label: "Description", width: 0.18 }, { label: "Scheduled value", width: 0.1, align: "right" },
      { label: "Previous", width: 0.09, align: "right" }, { label: "This period", width: 0.09, align: "right" }, { label: "Stored", width: 0.08, align: "right" },
      { label: "Completed & stored", width: 0.1, align: "right" }, { label: "%", width: 0.05, align: "right" }, { label: "Balance", width: 0.12, align: "right" }, { label: "Retainage", width: 0.11, align: "right" },
    ], [
      ...pa.lines.map((l: J) => [l.cost_code, l.description, money(l.scheduled_value), money(l.previous_work), money(l.work_this_period), money(l.materials_stored), money(l.completed_to_date), l.percent_complete, money(l.balance_to_finish), money(l.retainage)]),
      ["", "Total", money(t.contract_sum_to_date), "", "", "", money(t.completed_to_date), "", "", money(t.retainage)],
    ], { size: 7.5, boldLast: true });
    doc.signatures(["Contractor", "Architect", "Owner"]);
    return send(reply, doc, `Pay-application-${inv.number}.pdf`);
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId/punch-list.pdf", async (req, reply) => {
    requireUser(req);
    const items = await asCaller(req, `/api/projects/${req.params.projectId}/punch-items`) as unknown as J[];
    const doc = await PdfDoc.create("Punch list", await projectName(req, req.params.projectId));
    const open = items.filter((i) => i.status !== "closed").length;
    doc.paragraph(`${items.length} item(s), ${open} open.`);
    doc.table([{ label: "#", width: 0.06 }, { label: "Item", width: 0.34 }, { label: "Location", width: 0.16 }, { label: "Trade", width: 0.12 }, { label: "Assignee", width: 0.14 }, { label: "Due", width: 0.09 }, { label: "Status", width: 0.09 }],
      items.map((i) => [i.number, i.title, i.location ?? "", i.trade ?? "", i.assignee_name ?? "", i.due_date ? d(i.due_date) : "", `${lbl(i.status)}${i.overdue ? " (overdue)" : ""}`]));
    return send(reply, doc, "Punch-list.pdf");
  });
};
