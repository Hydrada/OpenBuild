# Feature-parity matrix (Procore → OpenBuild)

**This is a tracking matrix, not a parity claim.** Procore's tool list below comes from public sources (cited); it may differ by subscription. "Done" means it has passing API tests *and* a verified GUI workflow.

Sources:
- Procore certification course tool list (Bidding, Budget, Change Events, Commitments, Daily Log, Documents, Drawings, Inspections, Meetings, Models, Observations, Planroom, Prime Contracts, Punch List, RFIs, Specifications, Submittals): https://procoretest.skilljar.com/procore-certification-student
- Procore App Store listing (field, workforce, project management, quality & safety, financials): https://apps.apple.com/app/id374930542
- Procore Assist question categories (RFIs, Submittals, Budget, Change Events, Change Orders & Prime Contracts, Commitments, Daily Log, Punch List): https://support.procore.com/products/online/user-guide/project-level/assist/more-about-assist/sample-questions

| Area | Procore tool | OpenBuild status | Milestone |
|---|---|---|---|
| Core | Company/project directory, permissions | **Done (basic):** orgs, projects, org + project roles, invitations | M1 |
| Core | Project home / portfolio dashboard | **Done (basic):** status counts, open/overdue tasks, my tasks, activity | M1 |
| Core | Tasks | **Done (basic):** create, assign, due date, status | M1 |
| Core | Audit / change history | **Done:** append-only audit log, project activity feed | M1 |
| Docs | Drawings (sets, revisions, sheet numbers) | Planned | M2 |
| Docs | Documents (folders, versions) | Planned | M2 |
| Docs | Specifications | Planned | M2 |
| Docs | RFIs | Planned | M2 |
| Docs | Submittals | Planned | M2 |
| Docs | Markup / PDF viewing | Via OpenDraft adapter (not duplicated) | M5 |
| Docs | Meetings | Not scheduled | — |
| Docs | Models (BIM) | Out of scope for now | — |
| Field | Daily Log | Planned | M3 |
| Field | Inspections | Planned | M3 |
| Field | Punch List | Planned | M3 |
| Field | Observations / safety / incidents | Planned | M3 |
| Field | Photos | Planned | M3 |
| Field | Offline capture + sync | Planned | M6 |
| Field | Timesheets | Not scheduled | — |
| Financials | Budget, cost codes | Planned | M4 |
| Financials | Prime contracts, commitments | Planned | M4 |
| Financials | Change events / change orders | Planned | M4 |
| Financials | Invoices / pay applications | Planned | M4 |
| Financials | Forecasting, reports | Planned | M4 |
| Preconstruction | Bidding, Planroom | Not scheduled | — |
| Collab | Notifications (email/in-app), mentions, comments | Planned | M5 |
| Collab | Subcontractor portal | Planned | M5 |
| Admin | Custom fields, import/export, API keys, backups | Planned | M5–M6 |

## Existing open-source options reviewed
Construction-specific open-source suites are scarce; mature options are general-purpose:
OpenProject, Redmine, ERPNext (has a construction module), Odoo Community (partial add-ons).
Sources: https://fuzen.io/open-source-construction-management-software/ (vendor-authored; read with care),
https://www.saashub.com/open-source/procore-alternatives, https://alternativeto.net/software/procore.
None was adopted as a base: their data models are not organized around construction records (RFI/submittal/drawing-revision
workflows, AIA-style pay applications), and they would bring a second language/runtime. We reuse libraries, not platforms.
