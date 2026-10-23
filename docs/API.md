# OpenBuild REST API

Everything the web client does goes through this JSON API, so anything you can do in the UI you can automate.

## Authentication

| Method | How | CSRF header |
|---|---|---|
| Browser session | `POST /api/auth/login` sets an httpOnly `ob_session` cookie | Required on every non-GET request: `X-OpenBuild-CSRF: 1` |
| API key | `Authorization: Bearer ob_…` (create under **Settings → API keys**) | Not needed |

API keys act as the admin who created them, **only inside that company**. Requests for another company's ids return 404.
Revoke keys from Settings; revocation is immediate.

## Conventions

- JSON in, JSON out. Validation errors are `400 {"error": "...", "issues": [{"path": "...", "message": "..."}]}`.
- `401` = not signed in, `403` = signed in but your role does not allow it, `404` = not found **or not yours** (ids from other companies are never confirmed).
- Money is always a **string** with two decimals (`"1250.50"`). Send amounts as strings (`"1,250.50"` is accepted) or numbers; more than two decimals is rejected.
- Dates are `YYYY-MM-DD`; timestamps are ISO 8601.
- File uploads are `multipart/form-data` with one file in the `file` field (100 MB default limit).
- Field records accept an optional `clientId` (UUID). Re-sending the same create with the same `clientId` returns the original record with `200` and `"replayed": true` instead of creating a duplicate — use this for offline/retry-safe clients.

## Example

```sh
KEY=ob_xxx; HOST=https://build.example.com
ORG=$(curl -s -H "Authorization: Bearer $KEY" $HOST/api/me | jq -r '.orgs[0].id')
PROJECT=$(curl -s -H "Authorization: Bearer $KEY" $HOST/api/orgs/$ORG/projects | jq -r '.[0].id')
curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"subject":"Beam depth at grid C","question":"W18 or W21?"}' $HOST/api/projects/$PROJECT/rfis
curl -s -H "Authorization: Bearer $KEY" -F number=A-101 -F title="Ground floor" -F revision=0 -F file=@A-101.pdf \
  $HOST/api/projects/$PROJECT/drawings
```

## Endpoints

Generated from the server's route table (260 routes) by `scripts/gen-api-doc.mjs`. Permission checks are documented in [ARCHITECTURE.md](ARCHITECTURE.md#adr-004--permission-model-2026-10-22).

| Method | Path |
|---|---|
| `GET` | `/api/health` |
| `POST` | `/api/auth/register` |
| `POST` | `/api/auth/login` |
| `POST` | `/api/auth/logout` |
| `GET` | `/api/me` |
| `GET` | `/api/auth/config` |
| `GET` | `/api/invitations/:token` |
| `POST` | `/api/invitations/:token/accept` |
| `GET` | `/api/orgs/:orgId/projects` |
| `POST` | `/api/orgs/:orgId/projects` |
| `GET` | `/api/orgs/:orgId/members` |
| `PATCH` | `/api/orgs/:orgId/members/:userId` |
| `POST` | `/api/orgs/:orgId/invitations` |
| `GET` | `/api/orgs/:orgId/dashboard` |
| `GET` | `/api/orgs/:orgId/audit` |
| `GET` | `/api/projects/:projectId` |
| `PATCH` | `/api/projects/:projectId` |
| `GET` | `/api/projects/:projectId/members` |
| `PUT` | `/api/projects/:projectId/members/:userId` |
| `GET` | `/api/projects/:projectId/tasks` |
| `POST` | `/api/projects/:projectId/tasks` |
| `PATCH` | `/api/tasks/:taskId` |
| `GET` | `/api/projects/:projectId/activity` |
| `POST` | `/api/me/password` |
| `GET` | `/api/me/sessions` |
| `DELETE` | `/api/me/sessions/:id` |
| `POST` | `/api/auth/logout-all` |
| `POST` | `/api/orgs/:orgId/members/:userId/reset-link` |
| `GET` | `/api/password-resets/:token` |
| `POST` | `/api/password-resets/:token` |
| `DELETE` | `/api/orgs/:orgId/members/:userId` |
| `POST` | `/api/me/mfa/setup` |
| `POST` | `/api/me/mfa/enable` |
| `POST` | `/api/me/mfa/disable` |
| `POST` | `/api/orgs/:orgId/members/:userId/reset-mfa` |
| `GET` | `/api/me/notifications` |
| `POST` | `/api/me/notifications/read` |
| `POST` | `/api/projects/:projectId/files` |
| `GET` | `/api/projects/:projectId/files` |
| `GET` | `/api/files/:id/download` |
| `POST` | `/api/attachments` |
| `GET` | `/api/projects/:projectId/drawings` |
| `POST` | `/api/projects/:projectId/drawings` |
| `GET` | `/api/drawings/:id` |
| `POST` | `/api/drawing-revisions/:id/markups` |
| `GET` | `/api/projects/:projectId/folders` |
| `POST` | `/api/projects/:projectId/folders` |
| `GET` | `/api/projects/:projectId/documents` |
| `POST` | `/api/projects/:projectId/documents` |
| `POST` | `/api/documents/:id/versions` |
| `GET` | `/api/documents/:id` |
| `POST` | `/api/documents/:id/submit` |
| `POST` | `/api/approval-steps/:id/decide` |
| `GET` | `/api/me/approvals` |
| `GET` | `/api/projects/:projectId/specs` |
| `POST` | `/api/projects/:projectId/specs` |
| `GET` | `/api/projects/:projectId/rfis` |
| `POST` | `/api/projects/:projectId/rfis` |
| `GET` | `/api/rfis/:id` |
| `PATCH` | `/api/rfis/:id` |
| `POST` | `/api/rfis/:id/responses` |
| `POST` | `/api/rfis/:id/status` |
| `GET` | `/api/projects/:projectId/submittals` |
| `POST` | `/api/projects/:projectId/submittals` |
| `GET` | `/api/submittals/:id` |
| `PATCH` | `/api/submittals/:id` |
| `POST` | `/api/submittals/:id/submit` |
| `POST` | `/api/submittals/:id/revise` |
| `GET` | `/api/projects/:projectId/daily-logs` |
| `POST` | `/api/projects/:projectId/daily-logs` |
| `GET` | `/api/daily-logs/:id` |
| `PATCH` | `/api/daily-logs/:id` |
| `POST` | `/api/daily-logs/:id/sign` |
| `GET` | `/api/orgs/:orgId/inspection-templates` |
| `POST` | `/api/orgs/:orgId/inspection-templates` |
| `GET` | `/api/projects/:projectId/inspections` |
| `POST` | `/api/projects/:projectId/inspections` |
| `GET` | `/api/inspections/:id` |
| `PATCH` | `/api/inspections/:id/items/:itemId` |
| `POST` | `/api/inspections/:id/complete` |
| `GET` | `/api/projects/:projectId/punch-items` |
| `POST` | `/api/projects/:projectId/punch-items` |
| `GET` | `/api/punch-items/:id` |
| `PATCH` | `/api/punch-items/:id` |
| `POST` | `/api/punch-items/:id/status` |
| `GET` | `/api/projects/:projectId/observations` |
| `POST` | `/api/projects/:projectId/observations` |
| `GET` | `/api/observations/:id` |
| `POST` | `/api/observations/:id/close` |
| `GET` | `/api/projects/:projectId/incidents` |
| `POST` | `/api/projects/:projectId/incidents` |
| `GET` | `/api/incidents/:id` |
| `PATCH` | `/api/incidents/:id` |
| `GET` | `/api/projects/:projectId/cost-codes` |
| `POST` | `/api/projects/:projectId/cost-codes` |
| `GET` | `/api/projects/:projectId/budget` |
| `GET` | `/api/projects/:projectId/budget.csv` |
| `PUT` | `/api/projects/:projectId/budget/lines/:costCodeId` |
| `POST` | `/api/projects/:projectId/budget/lock` |
| `POST` | `/api/projects/:projectId/budget/modifications` |
| `GET` | `/api/projects/:projectId/contracts` |
| `POST` | `/api/projects/:projectId/contracts` |
| `GET` | `/api/contracts/:id` |
| `PATCH` | `/api/contracts/:id` |
| `POST` | `/api/contracts/:id/status` |
| `GET` | `/api/projects/:projectId/change-events` |
| `POST` | `/api/projects/:projectId/change-events` |
| `GET` | `/api/change-events/:id` |
| `PATCH` | `/api/change-events/:id` |
| `GET` | `/api/projects/:projectId/change-orders` |
| `POST` | `/api/projects/:projectId/change-orders` |
| `GET` | `/api/change-orders/:id` |
| `PATCH` | `/api/change-orders/:id` |
| `POST` | `/api/change-orders/:id/submit` |
| `POST` | `/api/change-orders/:id/void` |
| `GET` | `/api/projects/:projectId/invoices` |
| `POST` | `/api/projects/:projectId/invoices` |
| `POST` | `/api/contracts/:id/invoices` |
| `GET` | `/api/invoices/:id` |
| `GET` | `/api/invoices/:id/g703.csv` |
| `PUT` | `/api/invoices/:id/lines` |
| `POST` | `/api/invoices/:id/submit` |
| `POST` | `/api/invoices/:id/paid` |
| `DELETE` | `/api/invoices/:id` |
| `GET` | `/api/comments` |
| `POST` | `/api/comments` |
| `GET` | `/api/me/work` |
| `GET` | `/api/orgs/:orgId/api-keys` |
| `POST` | `/api/orgs/:orgId/api-keys` |
| `DELETE` | `/api/orgs/:orgId/api-keys/:id` |
| `POST` | `/api/drawing-revisions/:id/tool-session` |
| `GET` | `/api/tool/:token/file` |
| `POST` | `/api/tool/:token/markup` |
| `GET` | `/api/orgs/:orgId/custom-fields` |
| `POST` | `/api/orgs/:orgId/custom-fields` |
| `DELETE` | `/api/orgs/:orgId/custom-fields/:id` |
| `GET` | `/api/custom-values/:entityType/:entityId` |
| `PUT` | `/api/custom-values/:entityType/:entityId` |
| `GET` | `/api/projects/:projectId/export/:kind` |
| `POST` | `/api/projects/:projectId/import/:kind` |
| `GET` | `/api/projects/:projectId/calendar` |
| `PUT` | `/api/projects/:projectId/calendar` |
| `GET` | `/api/projects/:projectId/schedule` |
| `POST` | `/api/projects/:projectId/schedule` |
| `PATCH` | `/api/schedule/:id` |
| `DELETE` | `/api/schedule/:id` |
| `GET` | `/api/projects/:projectId/resources` |
| `POST` | `/api/projects/:projectId/resources` |
| `GET` | `/api/projects/:projectId/schedule/level` |
| `POST` | `/api/projects/:projectId/schedule/level` |
| `POST` | `/api/projects/:projectId/schedule/import` |
| `GET` | `/api/projects/:projectId/lookahead` |
| `POST` | `/api/projects/:projectId/lookahead-tasks` |
| `PATCH` | `/api/lookahead-tasks/:id` |
| `DELETE` | `/api/lookahead-tasks/:id` |
| `GET` | `/api/projects/:projectId/meetings` |
| `POST` | `/api/projects/:projectId/meetings` |
| `GET` | `/api/meetings/:id` |
| `POST` | `/api/meetings/:id/items` |
| `PATCH` | `/api/meetings/:id/items/:itemId` |
| `POST` | `/api/meetings/:id/publish` |
| `GET` | `/api/projects/:projectId/timesheets` |
| `POST` | `/api/projects/:projectId/timesheets` |
| `POST` | `/api/timesheets/:id/decide` |
| `GET` | `/api/projects/:projectId/bid-packages` |
| `POST` | `/api/projects/:projectId/bid-packages` |
| `GET` | `/api/bid-packages/:id` |
| `POST` | `/api/bid-packages/:id/bidders` |
| `POST` | `/api/bid-packages/:id/files` |
| `DELETE` | `/api/bid-packages/:id/files/:fileId` |
| `POST` | `/api/bid-packages/:id/status` |
| `POST` | `/api/bid-packages/:id/award` |
| `GET` | `/api/orgs/:orgId/bidder-companies` |
| `POST` | `/api/orgs/:orgId/bidder-companies` |
| `POST` | `/api/orgs/:orgId/bidder-companies/:id/prequal` |
| `GET` | `/api/bids/:token` |
| `GET` | `/api/bids/:token/files/:fileId` |
| `POST` | `/api/bids/:token` |
| `GET` | `/api/projects/:projectId/models` |
| `POST` | `/api/projects/:projectId/models` |
| `POST` | `/api/projects/:projectId/clashes` |
| `GET` | `/api/projects/:projectId/clashes` |
| `GET` | `/api/models/:id` |
| `GET` | `/api/projects/:projectId/correspondence` |
| `POST` | `/api/projects/:projectId/correspondence` |
| `GET` | `/api/correspondence/:id` |
| `POST` | `/api/correspondence/:id/send` |
| `POST` | `/api/correspondence/:id/acknowledge` |
| `POST` | `/api/correspondence/:id/status` |
| `GET` | `/api/projects/:projectId/direct-costs` |
| `POST` | `/api/projects/:projectId/direct-costs` |
| `POST` | `/api/direct-costs/:id/status` |
| `DELETE` | `/api/direct-costs/:id` |
| `GET` | `/api/projects/:projectId/tm-tickets` |
| `POST` | `/api/projects/:projectId/tm-tickets` |
| `GET` | `/api/tm-tickets/:id` |
| `PATCH` | `/api/tm-tickets/:id` |
| `POST` | `/api/tm-tickets/:id/status` |
| `POST` | `/api/tm-tickets/:id/change-event` |
| `GET` | `/api/projects/:projectId/equipment` |
| `POST` | `/api/projects/:projectId/equipment` |
| `GET` | `/api/equipment/:id` |
| `PATCH` | `/api/equipment/:id` |
| `POST` | `/api/equipment/:id/logs` |
| `GET` | `/api/projects/:projectId/action-plans` |
| `POST` | `/api/projects/:projectId/action-plans` |
| `GET` | `/api/action-plans/:id` |
| `POST` | `/api/action-plans/:id/items` |
| `PATCH` | `/api/action-plan-items/:id` |
| `GET` | `/api/action-plan-items/:id/files` |
| `GET` | `/api/projects/:projectId/warranties` |
| `POST` | `/api/projects/:projectId/warranties` |
| `GET` | `/api/warranties/:id` |
| `PATCH` | `/api/warranties/:id` |
| `GET` | `/api/projects/:projectId/coordination-issues` |
| `POST` | `/api/projects/:projectId/coordination-issues` |
| `POST` | `/api/clash-runs/:id/issues` |
| `GET` | `/api/coordination-issues/:id` |
| `PATCH` | `/api/coordination-issues/:id` |
| `GET` | `/api/projects/:projectId/timesheets/payroll` |
| `GET` | `/api/projects/:projectId/timesheets/payroll.csv` |
| `POST` | `/api/projects/:projectId/timesheets/mark-exported` |
| `GET` | `/api/projects/:projectId/search` |
| `GET` | `/api/orgs/:orgId/workers` |
| `POST` | `/api/orgs/:orgId/workers` |
| `POST` | `/api/projects/:projectId/workers` |
| `PATCH` | `/api/workers/:id` |
| `GET` | `/api/projects/:projectId/crews` |
| `POST` | `/api/projects/:projectId/crews` |
| `PATCH` | `/api/crews/:id` |
| `POST` | `/api/projects/:projectId/timesheets/crew` |
| `GET` | `/api/reports/datasets` |
| `POST` | `/api/orgs/:orgId/reports/run` |
| `GET` | `/api/orgs/:orgId/reports` |
| `POST` | `/api/orgs/:orgId/reports` |
| `GET` | `/api/reports/:id` |
| `GET` | `/api/reports/:id/csv` |
| `PATCH` | `/api/reports/:id` |
| `DELETE` | `/api/reports/:id` |
| `GET` | `/api/rfis/:id/pdf` |
| `GET` | `/api/submittals/:id/pdf` |
| `GET` | `/api/daily-logs/:id/pdf` |
| `GET` | `/api/meetings/:id/pdf` |
| `GET` | `/api/change-orders/:id/pdf` |
| `GET` | `/api/tm-tickets/:id/pdf` |
| `GET` | `/api/invoices/:id/pdf` |
| `GET` | `/api/projects/:projectId/punch-list.pdf` |
| `GET` | `/api/drawing-revisions/:id/annotations` |
| `PUT` | `/api/drawing-revisions/:id/annotations` |
| `POST` | `/api/drawing-revisions/:id/annotations/publish` |
| `PUT` | `/api/contracts/:id/contacts` |
| `PATCH` | `/api/contracts/:id/requirements` |
| `GET` | `/api/projects/:projectId/my-contracts` |
| `GET` | `/api/contracts/:id/compliance` |
| `POST` | `/api/contracts/:id/compliance` |
| `PATCH` | `/api/compliance-documents/:id` |
| `POST` | `/api/invoices/:id/lien-waivers` |
| `POST` | `/api/lien-waivers/:id/status` |
| `POST` | `/api/projects/:projectId/drawing-sets/analyze` |
| `POST` | `/api/projects/:projectId/drawing-sets/import` |
