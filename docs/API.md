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

Generated from the server's route table (135 routes). Permission checks are documented in [ARCHITECTURE.md](ARCHITECTURE.md#adr-004--permission-model-2026-10-22).

| Method | Path |
|---|---|
| `POST` | `/api/approval-steps/:id/decide` |
| `POST` | `/api/attachments` |
| `GET` | `/api/auth/config` |
| `POST` | `/api/auth/login` |
| `POST` | `/api/auth/logout` |
| `POST` | `/api/auth/logout-all` |
| `POST` | `/api/auth/register` |
| `GET` | `/api/change-events/:id` |
| `PATCH` | `/api/change-events/:id` |
| `GET` | `/api/change-orders/:id` |
| `PATCH` | `/api/change-orders/:id` |
| `POST` | `/api/change-orders/:id/submit` |
| `POST` | `/api/change-orders/:id/void` |
| `GET` | `/api/comments` |
| `POST` | `/api/comments` |
| `GET` | `/api/contracts/:id` |
| `PATCH` | `/api/contracts/:id` |
| `POST` | `/api/contracts/:id/status` |
| `GET` | `/api/custom-values/:entityType/:entityId` |
| `PUT` | `/api/custom-values/:entityType/:entityId` |
| `GET` | `/api/daily-logs/:id` |
| `PATCH` | `/api/daily-logs/:id` |
| `POST` | `/api/daily-logs/:id/sign` |
| `GET` | `/api/documents/:id` |
| `POST` | `/api/documents/:id/submit` |
| `POST` | `/api/documents/:id/versions` |
| `POST` | `/api/drawing-revisions/:id/markups` |
| `POST` | `/api/drawing-revisions/:id/tool-session` |
| `GET` | `/api/drawings/:id` |
| `GET` | `/api/files/:id/download` |
| `GET` | `/api/health` |
| `GET` | `/api/incidents/:id` |
| `PATCH` | `/api/incidents/:id` |
| `GET` | `/api/inspections/:id` |
| `POST` | `/api/inspections/:id/complete` |
| `PATCH` | `/api/inspections/:id/items/:itemId` |
| `GET` | `/api/invitations/:token` |
| `POST` | `/api/invitations/:token/accept` |
| `DELETE` | `/api/invoices/:id` |
| `GET` | `/api/invoices/:id` |
| `GET` | `/api/invoices/:id/g703.csv` |
| `PUT` | `/api/invoices/:id/lines` |
| `POST` | `/api/invoices/:id/paid` |
| `POST` | `/api/invoices/:id/submit` |
| `GET` | `/api/me` |
| `GET` | `/api/me/approvals` |
| `GET` | `/api/me/notifications` |
| `POST` | `/api/me/notifications/read` |
| `POST` | `/api/me/password` |
| `GET` | `/api/me/sessions` |
| `DELETE` | `/api/me/sessions/:id` |
| `GET` | `/api/me/work` |
| `GET` | `/api/observations/:id` |
| `POST` | `/api/observations/:id/close` |
| `GET` | `/api/orgs/:orgId/api-keys` |
| `POST` | `/api/orgs/:orgId/api-keys` |
| `DELETE` | `/api/orgs/:orgId/api-keys/:id` |
| `GET` | `/api/orgs/:orgId/audit` |
| `GET` | `/api/orgs/:orgId/custom-fields` |
| `POST` | `/api/orgs/:orgId/custom-fields` |
| `DELETE` | `/api/orgs/:orgId/custom-fields/:id` |
| `GET` | `/api/orgs/:orgId/dashboard` |
| `GET` | `/api/orgs/:orgId/inspection-templates` |
| `POST` | `/api/orgs/:orgId/inspection-templates` |
| `POST` | `/api/orgs/:orgId/invitations` |
| `GET` | `/api/orgs/:orgId/members` |
| `DELETE` | `/api/orgs/:orgId/members/:userId` |
| `PATCH` | `/api/orgs/:orgId/members/:userId` |
| `POST` | `/api/orgs/:orgId/members/:userId/reset-link` |
| `GET` | `/api/orgs/:orgId/projects` |
| `POST` | `/api/orgs/:orgId/projects` |
| `GET` | `/api/password-resets/:token` |
| `POST` | `/api/password-resets/:token` |
| `GET` | `/api/projects/:projectId` |
| `PATCH` | `/api/projects/:projectId` |
| `GET` | `/api/projects/:projectId/activity` |
| `GET` | `/api/projects/:projectId/budget` |
| `GET` | `/api/projects/:projectId/budget.csv` |
| `PUT` | `/api/projects/:projectId/budget/lines/:costCodeId` |
| `POST` | `/api/projects/:projectId/budget/lock` |
| `POST` | `/api/projects/:projectId/budget/modifications` |
| `GET` | `/api/projects/:projectId/change-events` |
| `POST` | `/api/projects/:projectId/change-events` |
| `GET` | `/api/projects/:projectId/change-orders` |
| `POST` | `/api/projects/:projectId/change-orders` |
| `GET` | `/api/projects/:projectId/contracts` |
| `POST` | `/api/projects/:projectId/contracts` |
| `GET` | `/api/projects/:projectId/cost-codes` |
| `POST` | `/api/projects/:projectId/cost-codes` |
| `GET` | `/api/projects/:projectId/daily-logs` |
| `POST` | `/api/projects/:projectId/daily-logs` |
| `GET` | `/api/projects/:projectId/documents` |
| `POST` | `/api/projects/:projectId/documents` |
| `GET` | `/api/projects/:projectId/drawings` |
| `POST` | `/api/projects/:projectId/drawings` |
| `GET` | `/api/projects/:projectId/export/:kind` |
| `GET` | `/api/projects/:projectId/files` |
| `POST` | `/api/projects/:projectId/files` |
| `GET` | `/api/projects/:projectId/folders` |
| `POST` | `/api/projects/:projectId/folders` |
| `POST` | `/api/projects/:projectId/import/:kind` |
| `GET` | `/api/projects/:projectId/incidents` |
| `POST` | `/api/projects/:projectId/incidents` |
| `GET` | `/api/projects/:projectId/inspections` |
| `POST` | `/api/projects/:projectId/inspections` |
| `GET` | `/api/projects/:projectId/invoices` |
| `POST` | `/api/projects/:projectId/invoices` |
| `GET` | `/api/projects/:projectId/members` |
| `PUT` | `/api/projects/:projectId/members/:userId` |
| `GET` | `/api/projects/:projectId/observations` |
| `POST` | `/api/projects/:projectId/observations` |
| `GET` | `/api/projects/:projectId/punch-items` |
| `POST` | `/api/projects/:projectId/punch-items` |
| `GET` | `/api/projects/:projectId/rfis` |
| `POST` | `/api/projects/:projectId/rfis` |
| `GET` | `/api/projects/:projectId/specs` |
| `POST` | `/api/projects/:projectId/specs` |
| `GET` | `/api/projects/:projectId/submittals` |
| `POST` | `/api/projects/:projectId/submittals` |
| `GET` | `/api/projects/:projectId/tasks` |
| `POST` | `/api/projects/:projectId/tasks` |
| `GET` | `/api/punch-items/:id` |
| `PATCH` | `/api/punch-items/:id` |
| `POST` | `/api/punch-items/:id/status` |
| `GET` | `/api/rfis/:id` |
| `PATCH` | `/api/rfis/:id` |
| `POST` | `/api/rfis/:id/responses` |
| `POST` | `/api/rfis/:id/status` |
| `GET` | `/api/submittals/:id` |
| `PATCH` | `/api/submittals/:id` |
| `POST` | `/api/submittals/:id/revise` |
| `POST` | `/api/submittals/:id/submit` |
| `PATCH` | `/api/tasks/:taskId` |
| `GET` | `/api/tool/:token/file` |
| `POST` | `/api/tool/:token/markup` |
