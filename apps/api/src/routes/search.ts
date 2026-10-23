import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { type AppConfig, requireUser } from "../app.js";
import { isSubcontractor, projectRoleAllows, requireProject } from "../lib/permissions.js";

/**
 * One searchable source. `text` is the SQL expression matched with ILIKE; `sub` (if set) is the extra condition
 * that makes a row visible to a subcontractor ($3 = user id). Sources without `sub` are hidden from subcontractors
 * unless `subAll` is set (drawings and specs are visible to everyone on the project).
 */
interface Source { kind: string; label: string; link: string; sql: string; text: string; sub?: string; subAll?: boolean }

const SOURCES: Source[] = [
  { kind: "rfi", label: "RFI", link: "/rfis/", sql: "SELECT id, 'RFI #' || number AS ref, subject AS title, status, created_at FROM rfis t", text: "number::text || ' ' || subject || ' ' || coalesce(question, '')", sub: "$3 IN (t.assignee_id, t.created_by)" },
  { kind: "submittal", label: "Submittal", link: "/submittals/", sql: "SELECT id, 'Submittal #' || number AS ref, title, status, created_at FROM submittals t", text: "number::text || ' ' || title", sub: "($3 = t.created_by OR $3 = ANY(t.reviewer_ids))" },
  { kind: "drawing", label: "Drawing", link: "/drawings/", sql: "SELECT id, number AS ref, title, NULL::text AS status, created_at FROM drawings t", text: "number || ' ' || title", subAll: true },
  { kind: "spec", label: "Specification", link: "", sql: "SELECT id, number AS ref, title, NULL::text AS status, created_at FROM spec_sections t", text: "number || ' ' || title", subAll: true },
  { kind: "document", label: "Document", link: "/documents/", sql: "SELECT id, NULL::text AS ref, name AS title, status, created_at FROM documents t", text: "name" },
  { kind: "punch", label: "Punch item", link: "/punch/", sql: "SELECT id, 'Punch #' || number AS ref, title, status, created_at FROM punch_items t", text: "number::text || ' ' || title || ' ' || coalesce(description, '')", sub: "$3 IN (t.assignee_id, t.created_by)" },
  { kind: "observation", label: "Observation", link: "/observations/", sql: "SELECT id, NULL::text AS ref, title, status, created_at FROM observations t", text: "title || ' ' || coalesce(description, '')", sub: "$3 IN (t.assignee_id, t.created_by)" },
  { kind: "incident", label: "Incident", link: "/incidents/", sql: "SELECT id, NULL::text AS ref, title, status, created_at FROM incidents t", text: "title || ' ' || coalesce(description, '')" },
  { kind: "inspection", label: "Inspection", link: "/inspections/", sql: "SELECT id, NULL::text AS ref, title, status, created_at FROM inspections t", text: "title" },
  { kind: "meeting", label: "Meeting", link: "/meetings/", sql: "SELECT id, NULL::text AS ref, title, status, created_at FROM meetings t", text: "title" },
  { kind: "task", label: "Task", link: "", sql: "SELECT id, NULL::text AS ref, title, status, created_at FROM tasks t", text: "title" },
  { kind: "change_event", label: "Change event", link: "/change-events/", sql: "SELECT id, 'CE #' || number AS ref, title, status, created_at FROM change_events t", text: "number::text || ' ' || title || ' ' || coalesce(description, '')" },
  { kind: "change_order", label: "Change order", link: "/change-orders/", sql: "SELECT id, 'CO #' || number AS ref, title, status, created_at FROM change_orders t", text: "number::text || ' ' || title" },
  { kind: "contract", label: "Contract", link: "/contracts/", sql: "SELECT id, '#' || number AS ref, title, status, created_at FROM contracts t", text: "number::text || ' ' || title || ' ' || counterparty" },
  { kind: "correspondence", label: "Correspondence", link: "/correspondence/", sql: "SELECT id, NULL::text AS ref, subject AS title, status, created_at FROM correspondence t", text: "subject || ' ' || coalesce(body, '')", sub: "EXISTS (SELECT 1 FROM correspondence_recipients r WHERE r.correspondence_id = t.id AND r.user_id = $3) AND t.status <> 'draft'" },
  { kind: "coordination_issue", label: "Coordination issue", link: "/coordination-issues/", sql: "SELECT id, '#' || number AS ref, title, status, created_at FROM coordination_issues t", text: "number::text || ' ' || title || ' ' || coalesce(description, '')", sub: "$3 IN (t.assignee_id, t.created_by)" },
  { kind: "action_plan", label: "Action plan", link: "/action-plans/", sql: "SELECT id, NULL::text AS ref, title, NULL::text AS status, created_at FROM action_plans t", text: "title" },
  { kind: "warranty", label: "Warranty", link: "/warranties/", sql: "SELECT id, NULL::text AS ref, item || ' — ' || company AS title, NULL::text AS status, created_at FROM warranties t", text: "item || ' ' || company" },
  { kind: "tm_ticket", label: "T&M ticket", link: "/tm-tickets/", sql: "SELECT id, 'T&M #' || number AS ref, description AS title, status, created_at FROM tm_tickets t", text: "number::text || ' ' || description || ' ' || coalesce(company, '')" },
];

export const searchRoutes = (config: AppConfig): FastifyPluginAsync => async (app) => {
  const { db } = config;

  /** Case-insensitive substring search across a project's records, limited to what the caller may see. */
  app.get<{ Params: { projectId: string }; Querystring: { q?: string } }>("/projects/:projectId/search", async (req) => {
    const user = requireUser(req);
    const access = await requireProject(db, user.id, req.params.projectId, "read");
    const q = z.string().trim().min(2, "Type at least 2 characters").max(100).parse(req.query.q ?? "");
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const sub = isSubcontractor(access);
    const full = projectRoleAllows(access.role, "read.full");
    // Private correspondence follows the same rule as the correspondence tool.
    const manager = projectRoleAllows(access.role, "record.manage");
    const parts: string[] = [];
    for (const s of SOURCES) {
      let visibility = "TRUE";
      if (sub) {
        if (s.subAll) visibility = "TRUE";
        else if (s.sub) visibility = s.sub;
        else continue;
      } else if (!full && !s.subAll && !s.sub) {
        continue;
      }
      if (s.kind === "correspondence" && !sub) {
        visibility = `(t.status <> 'draft' OR t.created_by = $3) AND (NOT t.private OR ${manager ? "TRUE" : "FALSE"} OR t.created_by = $3 OR EXISTS (SELECT 1 FROM correspondence_recipients r WHERE r.correspondence_id = t.id AND r.user_id = $3))`;
      }
      parts.push(`SELECT '${s.kind}' AS kind, '${s.label}' AS kind_label, '${s.link}' AS link, x.* FROM (${s.sql} WHERE t.project_id = $1 AND (${s.text}) ILIKE $2 ESCAPE '\\' AND ${visibility}) x`);
    }
    if (!parts.length) return { results: [] };
    const rows = await db.query<{ kind: string; kind_label: string; link: string; id: string; ref: string | null; title: string; status: string | null; created_at: string }>(
      `SELECT * FROM (${parts.join(" UNION ALL ")}) r
        ORDER BY (lower(coalesce(r.ref, '')) = lower($4) OR lower(r.title) = lower($4)) DESC, r.created_at DESC
        LIMIT 60`,
      [req.params.projectId, pattern, user.id, q],
    );
    return {
      results: rows.map((r) => ({
        kind: r.kind, kindLabel: r.kind_label, id: r.id, ref: r.ref, title: r.title, status: r.status,
        href: r.link ? `${r.link}${r.id}` : r.kind === "spec" ? `/projects/${req.params.projectId}/specs` : `/projects/${req.params.projectId}`,
      })),
    };
  });
};
