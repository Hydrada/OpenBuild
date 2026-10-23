/**
 * Report builder datasets. Every column, filter and grouping a caller can ask for is whitelisted here; user input only
 * ever selects keys from these maps and supplies bound parameter values.
 */
export type ColType = "text" | "number" | "money" | "date" | "status" | "boolean";
export interface ColumnDef { label: string; sql: string; type: ColType }
export interface Dataset {
  label: string;
  /** FROM clause; the main table is aliased `t` and has `project_id`. Joins add display columns. */
  from: string;
  columns: Record<string, ColumnDef>;
  /** Column used by the date-range filter. */
  dateColumn: string;
  /** Column used by the text filter. */
  textColumn: string;
  /** Column holding a user id for the "assigned to" filter, if any. */
  assigneeColumn?: string;
  statuses: string[];
}

const user = (alias: string, col: string) => `LEFT JOIN users ${alias} ON ${alias}.id = t.${col}`;

export const DATASETS: Record<string, Dataset> = {
  rfis: {
    label: "RFIs",
    from: `rfis t ${user("ua", "assignee_id")} ${user("uc", "created_by")}`,
    columns: {
      number: { label: "#", sql: "t.number", type: "number" },
      subject: { label: "Subject", sql: "t.subject", type: "text" },
      status: { label: "Status", sql: "t.status", type: "status" },
      assignee: { label: "Assignee", sql: "ua.name", type: "text" },
      created_by: { label: "Created by", sql: "uc.name", type: "text" },
      due_date: { label: "Due", sql: "t.due_date", type: "date" },
      created: { label: "Created", sql: "t.created_at::date", type: "date" },
      answered: { label: "Answered", sql: "t.answered_at::date", type: "date" },
      days_open: { label: "Days open", sql: "(coalesce(t.closed_at, now())::date - t.created_at::date)", type: "number" },
      overdue: { label: "Overdue", sql: "(t.status NOT IN ('answered','closed') AND t.due_date < current_date)", type: "boolean" },
      cost_impact: { label: "Cost impact", sql: "t.cost_impact", type: "text" },
      schedule_impact: { label: "Schedule impact", sql: "t.schedule_impact", type: "text" },
    },
    dateColumn: "t.created_at::date", textColumn: "t.subject", assigneeColumn: "t.assignee_id",
    statuses: ["draft", "open", "answered", "closed"],
  },
  submittals: {
    label: "Submittals",
    from: `submittals t ${user("uc", "created_by")}`,
    columns: {
      number: { label: "#", sql: "t.number", type: "number" },
      revision: { label: "Rev", sql: "t.revision", type: "number" },
      title: { label: "Title", sql: "t.title", type: "text" },
      type: { label: "Type", sql: "t.type", type: "status" },
      status: { label: "Status", sql: "t.status", type: "status" },
      due_date: { label: "Due", sql: "t.due_date", type: "date" },
      created_by: { label: "Created by", sql: "uc.name", type: "text" },
      created: { label: "Created", sql: "t.created_at::date", type: "date" },
    },
    dateColumn: "t.created_at::date", textColumn: "t.title",
    statuses: ["draft", "in_review", "approved", "approved_as_noted", "revise_resubmit", "rejected", "closed"],
  },
  punch_items: {
    label: "Punch list",
    from: `punch_items t ${user("ua", "assignee_id")}`,
    columns: {
      number: { label: "#", sql: "t.number", type: "number" },
      title: { label: "Item", sql: "t.title", type: "text" },
      location: { label: "Location", sql: "t.location", type: "text" },
      trade: { label: "Trade", sql: "t.trade", type: "text" },
      assignee: { label: "Assignee", sql: "ua.name", type: "text" },
      status: { label: "Status", sql: "t.status", type: "status" },
      due_date: { label: "Due", sql: "t.due_date", type: "date" },
      created: { label: "Created", sql: "t.created_at::date", type: "date" },
      closed: { label: "Closed", sql: "t.closed_at::date", type: "date" },
    },
    dateColumn: "t.created_at::date", textColumn: "t.title", assigneeColumn: "t.assignee_id",
    statuses: ["open", "ready_for_review", "closed"],
  },
  observations: {
    label: "Observations",
    from: `observations t ${user("ua", "assignee_id")}`,
    columns: {
      title: { label: "Title", sql: "t.title", type: "text" },
      type: { label: "Type", sql: "t.type", type: "status" },
      severity: { label: "Severity", sql: "t.severity", type: "status" },
      location: { label: "Location", sql: "t.location", type: "text" },
      assignee: { label: "Assignee", sql: "ua.name", type: "text" },
      status: { label: "Status", sql: "t.status", type: "status" },
      due_date: { label: "Due", sql: "t.due_date", type: "date" },
      created: { label: "Created", sql: "t.created_at::date", type: "date" },
    },
    dateColumn: "t.created_at::date", textColumn: "t.title", assigneeColumn: "t.assignee_id",
    statuses: ["open", "closed"],
  },
  incidents: {
    label: "Incidents",
    from: "incidents t",
    columns: {
      occurred: { label: "Occurred", sql: "t.occurred_at::date", type: "date" },
      type: { label: "Type", sql: "t.type", type: "status" },
      title: { label: "Title", sql: "t.title", type: "text" },
      location: { label: "Location", sql: "t.location", type: "text" },
      osha_recordable: { label: "OSHA recordable", sql: "t.osha_recordable", type: "boolean" },
      lost_time: { label: "Lost time", sql: "t.lost_time", type: "boolean" },
      status: { label: "Status", sql: "t.status", type: "status" },
    },
    dateColumn: "t.occurred_at::date", textColumn: "t.title",
    statuses: ["open", "investigating", "closed"],
  },
  change_orders: {
    label: "Change orders",
    from: "change_orders t JOIN contracts k ON k.id = t.contract_id",
    columns: {
      number: { label: "#", sql: "t.number", type: "number" },
      title: { label: "Title", sql: "t.title", type: "text" },
      contract: { label: "Contract", sql: "k.title", type: "text" },
      contract_kind: { label: "Contract type", sql: "k.kind", type: "status" },
      status: { label: "Status", sql: "t.status", type: "status" },
      amount: { label: "Amount", sql: "(SELECT coalesce(sum(l.amount), 0) FROM change_order_lines l WHERE l.change_order_id = t.id)", type: "money" },
      schedule_impact_days: { label: "Schedule impact (days)", sql: "t.schedule_impact_days", type: "number" },
      created: { label: "Created", sql: "t.created_at::date", type: "date" },
    },
    dateColumn: "t.created_at::date", textColumn: "t.title",
    statuses: ["draft", "pending", "approved", "rejected", "void"],
  },
  direct_costs: {
    label: "Direct costs",
    from: "direct_costs t JOIN cost_codes cc ON cc.id = t.cost_code_id",
    columns: {
      cost_date: { label: "Date", sql: "t.cost_date", type: "date" },
      kind: { label: "Type", sql: "t.kind", type: "status" },
      cost_code: { label: "Cost code", sql: "cc.code", type: "text" },
      vendor: { label: "Vendor", sql: "t.vendor", type: "text" },
      description: { label: "Description", sql: "t.description", type: "text" },
      amount: { label: "Amount", sql: "t.amount", type: "money" },
      status: { label: "Status", sql: "t.status", type: "status" },
    },
    dateColumn: "t.cost_date", textColumn: "t.description",
    statuses: ["pending", "approved", "rejected"],
  },
  timesheets: {
    label: "Timesheets",
    from: "timesheet_entries t LEFT JOIN users u ON u.id = t.user_id LEFT JOIN workers wk ON wk.id = t.worker_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id",
    columns: {
      work_date: { label: "Date", sql: "t.work_date", type: "date" },
      worker: { label: "Worker", sql: "coalesce(u.name, wk.name)", type: "text" },
      cost_code: { label: "Cost code", sql: "cc.code", type: "text" },
      hours: { label: "Hours", sql: "t.hours", type: "number" },
      status: { label: "Status", sql: "t.status", type: "status" },
      description: { label: "Work", sql: "t.description", type: "text" },
    },
    dateColumn: "t.work_date", textColumn: "coalesce(u.name, wk.name)",
    statuses: ["submitted", "approved", "rejected"],
  },
  coordination_issues: {
    label: "Coordination issues",
    from: `coordination_issues t ${user("ua", "assignee_id")}`,
    columns: {
      number: { label: "#", sql: "t.number", type: "number" },
      title: { label: "Title", sql: "t.title", type: "text" },
      type: { label: "Type", sql: "t.type", type: "status" },
      priority: { label: "Priority", sql: "t.priority", type: "status" },
      assignee: { label: "Assignee", sql: "ua.name", type: "text" },
      status: { label: "Status", sql: "t.status", type: "status" },
      due_date: { label: "Due", sql: "t.due_date", type: "date" },
      created: { label: "Created", sql: "t.created_at::date", type: "date" },
    },
    dateColumn: "t.created_at::date", textColumn: "t.title", assigneeColumn: "t.assignee_id",
    statuses: ["open", "in_progress", "ready_for_review", "closed"],
  },
  daily_manpower: {
    label: "Daily log manpower",
    from: "daily_log_manpower m JOIN daily_logs t ON t.id = m.log_id",
    columns: {
      log_date: { label: "Date", sql: "t.log_date", type: "date" },
      company: { label: "Company", sql: "m.company", type: "text" },
      trade: { label: "Trade", sql: "m.trade", type: "text" },
      workers: { label: "Workers", sql: "m.workers", type: "number" },
      hours: { label: "Hours", sql: "m.hours", type: "number" },
      log_status: { label: "Log status", sql: "t.status", type: "status" },
    },
    dateColumn: "t.log_date", textColumn: "m.company",
    statuses: ["open", "signed"],
  },
};

/** Common to every dataset: which project a row belongs to. */
export const PROJECT_COLUMN: ColumnDef = { label: "Project", sql: "p.name", type: "text" };
