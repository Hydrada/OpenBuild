# Changelog

## 0.2.0 — 2026-10-22 (unreleased)
- Project management: meetings with minutes and action items; schedule with critical path and float, with activities, milestones, dependencies, bar chart and dashboard milestones.
- Documents: drawings with revisions and markup sets, documents with versions and approvals, specifications, RFIs, submittals.
- Field: timesheets with manager approval; daily logs with manpower, inspections from templates, punch list, observations, incidents, photo library, offline capture.
- Financials: cost codes, budget (lock, transfers, EAC), contracts, change events and orders, AIA-style pay applications, CSV exports.
- Collaboration: comments and mentions, notifications (in-app + SMTP), subcontractor role, my-work portal, approvals inbox.
- Administration: TOTP two-factor login with recovery codes and admin reset, inline confirmations instead of browser dialogs, password reset, sessions, member removal, API keys, custom fields, CSV import/export, backup/restore CLI.
- Preconstruction: bid packages, bidder portal with planroom documents, leveling and award.
- Scheduling: multiple predecessors (FS/SS/FF/SF) with lag; Microsoft Project XML import.
- Bidder directory with prequalification.
- Correspondence (transmittals, notices, instructions, letters, memos) with acknowledgements.
- Custom reports: choose data, columns and filters, group and total, across projects; save, share and export CSV.
- Crews: a company directory of field workers without logins; foremen enter crew time, managers approve.
- Project-wide search; three-week lookahead with short-interval tasks.
- Action plans with a standard closeout checklist; warranties; coordination issues raised from clash runs; payroll export with weekly overtime.
- Fixed: editing one field of a task, meeting action item, contract, change event, change order, submittal or schedule activity reset other fields (status, retainage, reason/scope, schedule impact, type, % complete) to their defaults.
- Direct costs that feed the budget; T&M tickets that become change events; equipment register and usage log.
- Working calendar per project (weekdays and holidays) used by the critical path.
- Resources with daily capacity and resource levelling, with optional activity splitting; an activity can need several resources at once.
- Models: IFC register with version deltas, in-browser 3D viewer and exact-geometry clash detection between models, including clearance (soft) clashes.
- Single sign-on: OpenID Connect and SAML 2.0.
- Offline: photos queue on the device.
- Storage: S3-compatible driver (AWS S3, MinIO, R2, Backblaze).
- Offline: queued edits for daily logs, inspection results and punch status.
- Integrations: scoped links for OpenDraft and the Acrobat alternative.
- Hardening: route-wide authorization sweep, append-only audit trigger, date/money type safety, WCAG contrast fixes.
- Operations: Docker image with healthcheck, CI for PostgreSQL 16 and Docker Compose, install/recovery drill, load test, release workflow.

## 0.1.0 — 2026-10-22
- Foundation: auth, organizations, projects, roles, invitations, tasks, dashboard, audit log.
