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
| Core | Schedule & milestones | **Done (basic)** | Activities, milestones, multiple predecessors (FS/SS/FF/SF) with lag, loop prevention, late/conflict flags, critical path with total float, bar chart, dashboard milestones, working calendar (weekdays + holidays), resources with capacity (several per activity, e.g. crew plus pump), minimum-float resource levelling with optional activity splitting (preview/apply), Microsoft Project XML import (also from P6/ProjectLibre) |
| Docs | Drawings | **Done** | Sheets, revisions (current set = latest), sets, issue dates, inline PDF viewer, markup sets |
| Docs | Documents | **Done** | Folders, versions, sequential approval |
| Docs | Specifications | **Done** | MasterFormat sections with optional PDF |
| Docs | RFIs | **Done** | Numbering, ball-in-court, due/overdue, drawing/spec links, official answer, cost/schedule impact, attachments |
| Docs | Submittals | **Done** | Types, spec link, ordered reviewers, approve / as noted / revise & resubmit / reject, revisions |
| Docs | Markup / PDF editing | **Via adapters** | Scoped links for OpenDraft and the Acrobat alternative; markups stored per revision |
| Core | Correspondence | **Done** | Transmittals, notices, instructions, letters and memos numbered per type (TR-001…), recipients with read acknowledgement, private items, drafts, attachments, comments, close/reopen; subcontractors see only items addressed to them |
| Core | Action plans / closeout | **Done** | Checklists by section with assignees, due dates and required documents; standard closeout template (O&Ms, as-builts, warranties, lien waivers, CO…); copy a plan between projects; progress and overdue counts; subcontractors see and complete only their items |
| Core | Meetings | **Done** | Agenda, attendees, minutes, action items with owners and due dates, publish + notify |
| Docs | Coordination issues | **Done** | Raise from a clash run (one per clash, duplicates skipped) or manually; assignee → ready for review → closed by author/manager; attachments, comments, subcontractor scoping |
| Docs | Warranties | **Done** | Register by system and warrantor with start/end, expiring (60 days) and expired flags, documents |
| Docs | Models (BIM) | **Done** | IFC versions with element counts/changes, in-browser 3D viewer (web-ifc + three.js), clash detection between models (bounding-box candidates confirmed by exact triangle intersection and containment, plus clearance/soft clashes measured by surface distance) with stored runs and red highlighting in 3D |
| Field | Daily log | **Done** | Weather, temps, work, delays, visitors, manpower (decimal hours), photos, sign-off lock |
| Field | Inspections | **Done** | Templates, pass/fail/N-A, failed item → punch item, completion rule |
| Field | Punch list | **Done** | Assign, ready-for-review → verify with photo, CSV import |
| Field | Observations, incidents | **Done** | Severity, assignee, resolution; OSHA recordable/lost time, investigation, corrective action required to close |
| Field | Photos | **Done** | Library, camera capture on mobile, attach to records |
| Field | Offline capture | **Done** | Creates (replay-safe `clientId`), queued edits to daily logs, inspection results and punch status, and photos held in IndexedDB until reconnect |
| Field | T&M tickets | **Done** | Labor/material/equipment lines (qty × rate, half-even), field signature, submit → approve/reject, one-click change event per cost code, signed-ticket attachments |
| Field | Equipment | **Done** | Register (owned/rented/sub), status, daily operated/idle hours by cost code with a 24 h/day cap, operating cost at the hourly rate |
| Field | Timesheets | **Done** | Self-logged hours by cost code (incl. subcontractors), 24 h/day guard, manager approval, no self-approval, payroll CSV with weekly overtime (> 40 h) and sent-to-payroll marking |
| Financials | Budget, cost codes | **Done** | CSV import, lock, transfers, revised/committed/pending/exposure/cost-to-date/EAC/over-under, CSV export |
| Financials | Direct costs | **Done** | Expenses, vendor invoices, payroll and non-commitment sub invoices by cost code; approval by someone other than the author; approved costs feed the budget's direct costs and estimate at completion |
| Financials | Prime contracts, commitments | **Done** | Prime, subcontracts, POs, schedule of values, retainage |
| Financials | Change events, change orders | **Done** | Estimates, exposure, approval routing, deductive COs, void |
| Financials | Invoices / pay applications | **Done** | AIA G702/G703-style math, retainage, previous certificates, over-billing guard, G703 CSV |
| Financials | Forecasting | **Basic** | Forecast-to-complete per cost code drives EAC |
| Preconstruction | Bidding | **Done** | Bid packages, private bidder links (no account), revisions until due, leveling vs low bid, award → draft subcontract |
| Preconstruction | Planroom | **Done** | Drawings/specs shared per bid package, downloadable only through that package's bidder links |
| Preconstruction | Bidder directory & prequalification | **Done** | Company directory with trade, bonding, insurance expiry, EMR; approval requires current insurance; only prequalified companies invited from the directory |
| Collab | Comments, mentions, notifications | **Done** | In-app + optional email |
| Collab | Subcontractor portal | **Done** | Restricted role + "My work" |
| Admin | Custom fields | **Done** | Project, RFI, submittal, punch, observation, task |
| Admin | Audit log | **Done** | Database-enforced append-only |
| Admin | API keys, REST API | **Done** | See API.md |
| Admin | Import/export, backups | **Done** | CSV, backup/restore CLI |
| Admin | MFA | **Done** | TOTP authenticator apps (RFC 6238) |
| Admin | SSO | **Done (OIDC + SAML 2.0)** | OIDC with PKCE, nonce/state, RS256/JWKS; SAML with signed assertions, audience/recipient/time checks and replay protection; invited users only |

## Existing open-source options reviewed
Construction-specific open-source suites are scarce; mature options are general-purpose (OpenProject, Redmine, ERPNext, Odoo Community).
Sources: https://fuzen.io/open-source-construction-management-software/ (vendor-authored), https://www.saashub.com/open-source/procore-alternatives,
https://alternativeto.net/software/procore. None was adopted as a base (see ADR-001).
