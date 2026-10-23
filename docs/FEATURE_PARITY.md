# Feature-parity matrix (Procore → OpenBuild)

**This is a tracking matrix, not a parity claim.** Procore's tool list comes from public sources (cited) and may differ by subscription.
"Done" means passing API tests **and** a verified browser workflow (Playwright and/or CUA Driver). Depth is narrower than Procore's in most areas.

Sources:
- Procore certification course tool list: https://procoretest.skilljar.com/procore-certification-student
- Procore App Store listing: https://apps.apple.com/app/id374930542
- Procore Assist question categories: https://support.procore.com/products/online/user-guide/project-level/assist/more-about-assist/sample-questions

| Area | Procore tool | OpenBuild | Notes |
|---|---|---|---|
| Core | Company/project directory, permissions | **Done** | Org roles owner/admin/member; project roles manager/contributor/viewer/subcontractor |
| Core | Portfolio dashboard, project home | **Done** | Status counts, open/overdue tasks, my tasks, activity |
| Core | Tasks | **Done** | Assign, due date, status, CSV import/export |
| Docs | Drawings | **Done** | Sheets, revisions (current set = latest), sets, issue dates, inline PDF viewer, markup sets |
| Docs | Documents | **Done** | Folders, versions, sequential approval |
| Docs | Specifications | **Done** | MasterFormat sections with optional PDF |
| Docs | RFIs | **Done** | Numbering, ball-in-court, due/overdue, drawing/spec links, official answer, cost/schedule impact, attachments |
| Docs | Submittals | **Done** | Types, spec link, ordered reviewers, approve / as noted / revise & resubmit / reject, revisions |
| Docs | Markup / PDF editing | **Via adapters** | Scoped links for OpenDraft and the Acrobat alternative; markups stored per revision |
| Docs | Meetings, Models (BIM) | Not built | |
| Field | Daily log | **Done** | Weather, temps, work, delays, visitors, manpower (decimal hours), photos, sign-off lock |
| Field | Inspections | **Done** | Templates, pass/fail/N-A, failed item → punch item, completion rule |
| Field | Punch list | **Done** | Assign, ready-for-review → verify with photo, CSV import |
| Field | Observations, incidents | **Done** | Severity, assignee, resolution; OSHA recordable/lost time, investigation, corrective action required to close |
| Field | Photos | **Done** | Library, camera capture on mobile, attach to records |
| Field | Offline capture | **Done (create only)** | Outbox + replay-safe `clientId`; editing offline not supported |
| Field | Timesheets | Not built | |
| Financials | Budget, cost codes | **Done** | CSV import, lock, transfers, revised/committed/pending/exposure/cost-to-date/EAC/over-under, CSV export |
| Financials | Prime contracts, commitments | **Done** | Prime, subcontracts, POs, schedule of values, retainage |
| Financials | Change events, change orders | **Done** | Estimates, exposure, approval routing, deductive COs, void |
| Financials | Invoices / pay applications | **Done** | AIA G702/G703-style math, retainage, previous certificates, over-billing guard, G703 CSV |
| Financials | Forecasting | **Basic** | Forecast-to-complete per cost code drives EAC |
| Preconstruction | Bidding, Planroom | Not built | |
| Collab | Comments, mentions, notifications | **Done** | In-app + optional email |
| Collab | Subcontractor portal | **Done** | Restricted role + "My work" |
| Admin | Custom fields | **Done** | Project, RFI, submittal, punch, observation, task |
| Admin | Audit log | **Done** | Database-enforced append-only |
| Admin | API keys, REST API | **Done** | See API.md |
| Admin | Import/export, backups | **Done** | CSV, backup/restore CLI |
| Admin | SSO / MFA | Not built | |

## Existing open-source options reviewed
Construction-specific open-source suites are scarce; mature options are general-purpose (OpenProject, Redmine, ERPNext, Odoo Community).
Sources: https://fuzen.io/open-source-construction-management-software/ (vendor-authored), https://www.saashub.com/open-source/procore-alternatives,
https://alternativeto.net/software/procore. None was adopted as a base (see ADR-001).
