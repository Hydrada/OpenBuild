/**
 * Project tools that a permission template can restrict, and which API routes belong to each. A route not listed here
 * (projects, members, comments, files, search...) is governed by the project role alone.
 */
export const TOOLS = {
  drawings: "Drawings",
  documents: "Documents",
  specs: "Specifications",
  models: "Models (BIM) and coordination",
  rfis: "RFIs",
  submittals: "Submittals",
  correspondence: "Correspondence",
  schedule: "Schedule and lookahead",
  meetings: "Meetings",
  action_plans: "Action plans and warranties",
  daily_log: "Daily log",
  inspections: "Inspections",
  punch: "Punch list",
  observations: "Observations",
  incidents: "Incidents",
  photos: "Photos",
  timesheets: "Timesheets and crews",
  equipment: "Equipment",
  tm_tickets: "T&M tickets",
  budget: "Budget, cost codes and direct costs",
  commitments: "Contracts, change events, change orders and invoices",
  bidding: "Bidding",
} as const;
export type Tool = keyof typeof TOOLS;
export type ToolLevel = "none" | "read" | "standard" | "admin";

/** First path segment (after /api/ or /api/projects/:projectId/) → tool. */
const SEGMENTS: Record<string, Tool> = {
  drawings: "drawings", "drawing-revisions": "drawings", "drawing-sets": "drawings",
  documents: "documents", folders: "documents",
  specs: "specs",
  models: "models", clashes: "models", "clash-runs": "models", "coordination-issues": "models",
  rfis: "rfis",
  submittals: "submittals",
  correspondence: "correspondence",
  schedule: "schedule", calendar: "schedule", resources: "schedule", lookahead: "schedule", "lookahead-tasks": "schedule",
  meetings: "meetings",
  "action-plans": "action_plans", "action-plan-items": "action_plans", warranties: "action_plans",
  "daily-logs": "daily_log", "daily-log-entries": "daily_log",
  inspections: "inspections",
  "punch-items": "punch", "punch-list.pdf": "punch",
  observations: "observations",
  incidents: "incidents",
  photos: "photos", "photo-albums": "photos",
  timesheets: "timesheets", crews: "timesheets", workers: "timesheets",
  equipment: "equipment",
  "tm-tickets": "tm_tickets",
  budget: "budget", "budget.csv": "budget", "cost-codes": "budget", "direct-costs": "budget",
  contracts: "commitments", "change-events": "commitments", "change-orders": "commitments", invoices: "commitments",
  "lien-waivers": "commitments", "compliance-documents": "commitments", "my-contracts": "commitments",
  "bid-packages": "bidding",
};

export function toolForRoute(url: string | undefined): Tool | null {
  if (!url?.startsWith("/api/")) return null;
  const parts = url.slice(5).split("/");
  const seg = parts[0] === "projects" && parts[1] === ":projectId" ? parts[2] : parts[0];
  return seg ? SEGMENTS[seg] ?? null : null;
}

/** Report datasets and search sources map onto the same tools. */
export const DATASET_TOOL: Record<string, Tool> = {
  rfis: "rfis", submittals: "submittals", punch_items: "punch", observations: "observations", incidents: "incidents",
  change_orders: "commitments", direct_costs: "budget", timesheets: "timesheets", coordination_issues: "models", daily_manpower: "daily_log",
};
