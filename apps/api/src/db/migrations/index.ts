/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped;
 * add a new one instead. Each runs in its own transaction.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: "0001_foundation",
    sql: /* sql */ `
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_memberships (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text,
  address     text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('bidding','active','on_hold','closed')),
  start_date  date,
  end_date    date,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org_idx ON projects (org_id);

CREATE TABLE project_memberships (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('manager','contributor','viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       text NOT NULL,
  org_role    text NOT NULL CHECK (org_role IN ('admin','member')),
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  project_role text CHECK (project_role IN ('manager','contributor','viewer')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz
);

CREATE TABLE tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date    date,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_project_idx ON tasks (project_id);

-- Append-only: the application never issues UPDATE or DELETE against this table.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  uuid,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_project_idx ON audit_log (project_id, created_at DESC);
`,
  },
  {
    id: "0002_accounts_and_documents",
    sql: /* sql */ `
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sessions ADD COLUMN user_agent text;
CREATE UNIQUE INDEX sessions_id_key ON sessions (id);

CREATE TABLE password_resets (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  name        text NOT NULL,
  mime        text NOT NULL,
  size        bigint NOT NULL,
  sha256      text NOT NULL,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_project_idx ON files (project_id, created_at DESC);

CREATE TABLE attachments (
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, file_id)
);

CREATE TABLE drawings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      text NOT NULL,
  title       text NOT NULL,
  discipline  text NOT NULL DEFAULT 'General',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE drawing_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id  uuid NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  revision    text NOT NULL,
  set_name    text,
  issued_date date,
  file_id     uuid NOT NULL REFERENCES files(id),
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (drawing_id, revision)
);

CREATE TABLE markup_sets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES drawing_revisions(id) ON DELETE CASCADE,
  file_id     uuid NOT NULL REFERENCES files(id),
  tool        text NOT NULL DEFAULT 'manual',
  note        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES folders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_id   uuid REFERENCES folders(id) ON DELETE SET NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','rejected')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     int NOT NULL,
  file_id     uuid NOT NULL REFERENCES files(id),
  note        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

-- Sequential approval routing shared by documents and submittals.
CREATE TABLE approval_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('document','submittal')),
  entity_id   uuid NOT NULL,
  round       int NOT NULL DEFAULT 1,
  seq         int NOT NULL,
  approver_id uuid NOT NULL REFERENCES users(id),
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','approved_as_noted','revise_resubmit','rejected','skipped')),
  comment     text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, round, seq)
);
CREATE INDEX approval_steps_approver_idx ON approval_steps (approver_id, status);

CREATE TABLE spec_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      text NOT NULL,
  title       text NOT NULL,
  file_id     uuid REFERENCES files(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE rfis (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number          int NOT NULL,
  subject         text NOT NULL,
  question        text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','answered','closed')),
  assignee_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date        date,
  drawing_id      uuid REFERENCES drawings(id) ON DELETE SET NULL,
  spec_section_id uuid REFERENCES spec_sections(id) ON DELETE SET NULL,
  cost_impact     text NOT NULL DEFAULT 'tbd' CHECK (cost_impact IN ('tbd','yes','no')),
  schedule_impact text NOT NULL DEFAULT 'tbd' CHECK (schedule_impact IN ('tbd','yes','no')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz,
  closed_at       timestamptz,
  UNIQUE (project_id, number)
);

CREATE TABLE rfi_responses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfi_id      uuid NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,
  body        text NOT NULL,
  is_official boolean NOT NULL DEFAULT false,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submittals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number          int NOT NULL,
  revision        int NOT NULL DEFAULT 0,
  title           text NOT NULL,
  type            text NOT NULL DEFAULT 'shop_drawing'
                  CHECK (type IN ('shop_drawing','product_data','sample','mockup','other')),
  spec_section_id uuid REFERENCES spec_sections(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','in_review','approved','approved_as_noted','revise_resubmit','rejected','closed')),
  due_date        date,
  reviewer_ids    uuid[] NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number, revision)
);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  link        text,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  body        text NOT NULL,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_entity_idx ON comments (entity_type, entity_id, created_at);
`,
  },
  {
    id: "0003_field",
    sql: /* sql */ `
CREATE TABLE daily_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  log_date    date NOT NULL,
  weather     text,
  temp_low    numeric(5,1),
  temp_high   numeric(5,1),
  work_performed text,
  delays      text,
  visitors    text,
  notes       text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','signed')),
  signed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  signed_at   timestamptz,
  client_id   uuid,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, log_date),
  UNIQUE (project_id, client_id)
);

CREATE TABLE daily_log_manpower (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id      uuid NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  company     text NOT NULL,
  trade       text,
  workers     int NOT NULL CHECK (workers >= 0),
  hours       numeric(8,2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  notes       text
);

CREATE TABLE inspection_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  items       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inspections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  template_id uuid REFERENCES inspection_templates(id) ON DELETE SET NULL,
  location    text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
  inspector_id uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  client_id   uuid,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, client_id)
);

CREATE TABLE punch_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      int NOT NULL,
  title       text NOT NULL,
  description text,
  location    text,
  trade       text,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ready_for_review','closed')),
  due_date    date,
  client_id   uuid,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  UNIQUE (project_id, number),
  UNIQUE (project_id, client_id)
);

CREATE TABLE inspection_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  seq           int NOT NULL,
  text          text NOT NULL,
  result        text CHECK (result IN ('pass','fail','na')),
  note          text,
  punch_item_id uuid REFERENCES punch_items(id) ON DELETE SET NULL,
  UNIQUE (inspection_id, seq)
);

CREATE TABLE observations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('safety','quality','environmental','housekeeping')),
  severity    text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  title       text NOT NULL,
  description text,
  location    text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date    date,
  resolution  text,
  client_id   uuid,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  UNIQUE (project_id, client_id)
);

CREATE TABLE incidents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  occurred_at     timestamptz NOT NULL,
  type            text NOT NULL CHECK (type IN ('injury','near_miss','property_damage','environmental')),
  title           text NOT NULL,
  description     text NOT NULL,
  location        text,
  injured_party   text,
  osha_recordable boolean NOT NULL DEFAULT false,
  lost_time       boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','closed')),
  root_cause      text,
  corrective_action text,
  client_id       uuid,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  UNIQUE (project_id, client_id)
);
`,
  },
  {
    id: "0004_financials",
    sql: /* sql */ `
ALTER TABLE approval_steps DROP CONSTRAINT approval_steps_entity_type_check;
ALTER TABLE approval_steps ADD CONSTRAINT approval_steps_entity_type_check
  CHECK (entity_type IN ('document','submittal','change_order','invoice'));

CREATE TABLE cost_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        text NOT NULL,
  description text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

CREATE TABLE budget_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cost_code_id         uuid NOT NULL REFERENCES cost_codes(id) ON DELETE CASCADE,
  original_amount      numeric(18,2) NOT NULL DEFAULT 0,
  forecast_to_complete numeric(18,2),
  notes                text,
  locked               boolean NOT NULL DEFAULT false,
  UNIQUE (project_id, cost_code_id)
);

-- Transfers between budget lines; each row nets to zero across from/to.
CREATE TABLE budget_modifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_cost_code_id uuid NOT NULL REFERENCES cost_codes(id),
  to_cost_code_id   uuid NOT NULL REFERENCES cost_codes(id),
  amount            numeric(18,2) NOT NULL CHECK (amount > 0),
  reason            text NOT NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (from_cost_code_id <> to_cost_code_id)
);

CREATE TABLE contracts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number            int NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('prime','subcontract','purchase_order')),
  title             text NOT NULL,
  counterparty      text NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','complete','terminated')),
  retainage_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (retainage_percent >= 0 AND retainage_percent <= 100),
  executed_date     date,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  approved_at       timestamptz,
  UNIQUE (project_id, number)
);

CREATE TABLE contract_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq          int NOT NULL,
  cost_code_id uuid NOT NULL REFERENCES cost_codes(id),
  description  text NOT NULL,
  amount       numeric(18,2) NOT NULL,
  UNIQUE (contract_id, seq)
);

CREATE TABLE change_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number      int NOT NULL,
  title       text NOT NULL,
  description text,
  reason      text NOT NULL DEFAULT 'owner_change' CHECK (reason IN ('owner_change','design_error','unforeseen_condition','allowance','other')),
  scope       text NOT NULL DEFAULT 'tbd' CHECK (scope IN ('in_scope','out_of_scope','tbd')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','void')),
  rfi_id      uuid REFERENCES rfis(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE change_event_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_event_id   uuid NOT NULL REFERENCES change_events(id) ON DELETE CASCADE,
  cost_code_id      uuid NOT NULL REFERENCES cost_codes(id),
  description       text NOT NULL,
  estimated_cost    numeric(18,2) NOT NULL DEFAULT 0,
  estimated_revenue numeric(18,2) NOT NULL DEFAULT 0
);

CREATE TABLE change_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contract_id     uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  number          int NOT NULL,
  change_event_id uuid REFERENCES change_events(id) ON DELETE SET NULL,
  title           text NOT NULL,
  description     text,
  schedule_impact_days int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved','rejected','void')),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  UNIQUE (project_id, number)
);

CREATE TABLE change_order_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_order_id uuid NOT NULL REFERENCES change_orders(id) ON DELETE CASCADE,
  seq             int NOT NULL,
  cost_code_id    uuid NOT NULL REFERENCES cost_codes(id),
  description     text NOT NULL,
  amount          numeric(18,2) NOT NULL,
  UNIQUE (change_order_id, seq)
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contract_id   uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  number        int NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','paid')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  paid_at       timestamptz,
  UNIQUE (project_id, number),
  CHECK (period_end >= period_start)
);

-- One row per schedule-of-values item (contract line or approved CO line).
CREATE TABLE invoice_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  contract_line_id     uuid REFERENCES contract_lines(id),
  change_order_line_id uuid REFERENCES change_order_lines(id),
  work_this_period     numeric(18,2) NOT NULL DEFAULT 0 CHECK (work_this_period >= 0),
  materials_stored     numeric(18,2) NOT NULL DEFAULT 0 CHECK (materials_stored >= 0),
  CHECK ((contract_line_id IS NULL) <> (change_order_line_id IS NULL))
);
CREATE UNIQUE INDEX invoice_lines_cl_key ON invoice_lines (invoice_id, contract_line_id) WHERE contract_line_id IS NOT NULL;
CREATE UNIQUE INDEX invoice_lines_col_key ON invoice_lines (invoice_id, change_order_line_id) WHERE change_order_line_id IS NOT NULL;
`,
  },
  {
    id: "0005_collaboration",
    sql: /* sql */ `
-- Subcontractor collaborators: see only what is assigned to them, plus drawings and specs.
ALTER TABLE project_memberships DROP CONSTRAINT project_memberships_role_check;
ALTER TABLE project_memberships ADD CONSTRAINT project_memberships_role_check
  CHECK (role IN ('manager','contributor','viewer','subcontractor'));
ALTER TABLE invitations DROP CONSTRAINT invitations_project_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_project_role_check
  CHECK (project_role IN ('manager','contributor','viewer','subcontractor'));
ALTER TABLE org_memberships ADD COLUMN company text;
ALTER TABLE invitations ADD COLUMN company text;

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

-- Short-lived capability for an external document tool: download one revision, upload one markup.
CREATE TABLE tool_tokens (
  token_hash  text PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES drawing_revisions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  uploaded_at timestamptz
);

CREATE TABLE custom_field_defs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('project','rfi','submittal','punch_item','observation','task')),
  key         text NOT NULL,
  label       text NOT NULL,
  type        text NOT NULL CHECK (type IN ('text','number','date','select','boolean')),
  options     jsonb NOT NULL DEFAULT '[]'::jsonb,
  required    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, entity_type, key)
);

CREATE TABLE custom_field_values (
  field_id    uuid NOT NULL REFERENCES custom_field_defs(id) ON DELETE CASCADE,
  entity_id   uuid NOT NULL,
  value       text NOT NULL,
  PRIMARY KEY (field_id, entity_id)
);
`,
  },
  {
    id: "0006_audit_append_only",
    sql: /* sql */ `
-- The audit trail is append-only at the database level, not just by convention.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END
$fn$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
`,
  },
  {
    id: "0007_schedule",
    sql: /* sql */ `
CREATE TABLE schedule_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             text NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  is_milestone     boolean NOT NULL DEFAULT false,
  percent_complete int NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 100),
  predecessor_id   uuid REFERENCES schedule_items(id) ON DELETE SET NULL,
  assignee_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (NOT is_milestone OR start_date = end_date)
);
CREATE INDEX schedule_items_project_idx ON schedule_items (project_id, start_date);
`,
  },
  {
    id: "0008_meetings_timesheets_mfa",
    sql: /* sql */ `
CREATE TABLE meetings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  location    text,
  status      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','minutes_published')),
  attendee_ids uuid[] NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE TABLE meeting_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  seq         int NOT NULL,
  topic       text NOT NULL,
  notes       text,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date    date,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

CREATE TABLE timesheet_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date    date NOT NULL,
  cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
  hours        numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  description  text,
  status       text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected')),
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timesheet_project_idx ON timesheet_entries (project_id, work_date);

ALTER TABLE users ADD COLUMN totp_secret text;
ALTER TABLE users ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false;
`,
  },
  {
    id: "0009_mfa_recovery",
    sql: /* sql */ `
ALTER TABLE users ADD COLUMN mfa_recovery_hashes text[] NOT NULL DEFAULT '{}';
`,
  },
  {
    id: "0010_bidding",
    sql: /* sql */ `
CREATE TABLE bid_packages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       int NOT NULL,
  title        text NOT NULL,
  scope        text,
  cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
  due_at       timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','awarded')),
  awarded_bidder_id uuid,
  contract_id  uuid REFERENCES contracts(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE bidders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id   uuid NOT NULL REFERENCES bid_packages(id) ON DELETE CASCADE,
  company      text NOT NULL,
  email        text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','declined','submitted')),
  amount       numeric(18,2),
  notes        text,
  submitted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "0011_oidc",
    sql: /* sql */ `
CREATE TABLE oidc_states (
  state_hash    text PRIMARY KEY,
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  return_to     text NOT NULL DEFAULT '/',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
`,
  },
  {
    id: "0012_bim",
    sql: /* sql */ `
CREATE TABLE bim_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  discipline  text NOT NULL DEFAULT 'Architectural',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE bim_model_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id    uuid NOT NULL REFERENCES bim_models(id) ON DELETE CASCADE,
  version     int NOT NULL,
  file_id     uuid NOT NULL REFERENCES files(id),
  ifc_schema  text,
  element_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);
`,
  },
  {
    id: "0013_schedule_links_planroom",
    sql: /* sql */ `
-- Many-to-many finish-to-start dependencies replace the single predecessor column.
CREATE TABLE schedule_links (
  successor_id   uuid NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
  predecessor_id uuid NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
  lag_days       int NOT NULL DEFAULT 0 CHECK (lag_days BETWEEN -3650 AND 3650),
  PRIMARY KEY (successor_id, predecessor_id),
  CHECK (successor_id <> predecessor_id)
);
INSERT INTO schedule_links (successor_id, predecessor_id) SELECT id, predecessor_id FROM schedule_items WHERE predecessor_id IS NOT NULL;
ALTER TABLE schedule_items DROP COLUMN predecessor_id;
ALTER TABLE schedule_items ADD COLUMN external_ref text;

-- Planroom: documents shared with bidders through their private bid link.
CREATE TABLE bid_package_files (
  package_id uuid NOT NULL REFERENCES bid_packages(id) ON DELETE CASCADE,
  file_id    uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (package_id, file_id)
);
`,
  },
  {
    id: "0014_link_types_prequal",
    sql: /* sql */ `
ALTER TABLE schedule_links ADD COLUMN link_type text NOT NULL DEFAULT 'FS' CHECK (link_type IN ('FS','SS','FF','SF'));

-- Bidder directory with prequalification, reused across bid packages.
CREATE TABLE bidder_companies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  trade        text,
  email        text NOT NULL,
  prequal_status text NOT NULL DEFAULT 'pending' CHECK (prequal_status IN ('pending','approved','rejected')),
  bonding_limit numeric(18,2),
  insurance_expires date,
  emr          numeric(4,2),
  notes        text,
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
ALTER TABLE bidders ADD COLUMN company_id uuid REFERENCES bidder_companies(id) ON DELETE SET NULL;
`,
  },
  {
    id: "0015_work_calendar",
    sql: /* sql */ `
-- Per-project working calendar: which weekdays are worked (0 = Sunday … 6 = Saturday) and non-working dates.
-- Default is every day, so existing schedules keep their dates after the upgrade.
ALTER TABLE projects ADD COLUMN work_days int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}';
CREATE TABLE project_holidays (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day        date NOT NULL,
  name       text NOT NULL,
  PRIMARY KEY (project_id, day)
);
`,
  },
  {
    id: "0016_resources",
    sql: /* sql */ `
-- Crews and equipment with a daily capacity, assigned to schedule activities for resource levelling.
CREATE TABLE schedule_resources (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  capacity   int NOT NULL CHECK (capacity BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
ALTER TABLE schedule_items ADD COLUMN resource_id uuid REFERENCES schedule_resources(id) ON DELETE SET NULL;
ALTER TABLE schedule_items ADD COLUMN resource_units int NOT NULL DEFAULT 1 CHECK (resource_units BETWEEN 1 AND 10000);
`,
  },
  {
    id: "0017_clash_runs",
    sql: /* sql */ `
-- Recorded clash-detection runs between two model versions.
CREATE TABLE clash_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_a   uuid NOT NULL REFERENCES bim_model_versions(id) ON DELETE CASCADE,
  version_b   uuid NOT NULL REFERENCES bim_model_versions(id) ON DELETE CASCADE,
  tolerance_m numeric(6,3) NOT NULL,
  clash_count int NOT NULL,
  results     jsonb NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: "0018_splittable",
    sql: /* sql */ `
-- Activities that may be interrupted during resource levelling, and the work segments levelling chose.
ALTER TABLE schedule_items ADD COLUMN splittable boolean NOT NULL DEFAULT false;
ALTER TABLE schedule_items ADD COLUMN segments jsonb;
`,
  },
  {
    id: "0019_assignments",
    sql: /* sql */ `
-- Several resources per activity (e.g. a concrete crew plus a pump), each with its own units.
CREATE TABLE schedule_assignments (
  item_id     uuid NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES schedule_resources(id) ON DELETE CASCADE,
  units       int NOT NULL DEFAULT 1 CHECK (units BETWEEN 1 AND 10000),
  PRIMARY KEY (item_id, resource_id)
);
INSERT INTO schedule_assignments (item_id, resource_id, units)
  SELECT id, resource_id, resource_units FROM schedule_items WHERE resource_id IS NOT NULL;
ALTER TABLE schedule_items DROP COLUMN resource_id;
ALTER TABLE schedule_items DROP COLUMN resource_units;
`,
  },
  {
    id: "0020_project_tools",
    sql: /* sql */ `
-- Correspondence (transmittals, notices, instructions, letters), direct costs, T&M tickets, equipment.
CREATE TABLE correspondence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('transmittal','notice','instruction','letter','memo')),
  number       int NOT NULL,
  subject      text NOT NULL,
  body         text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','closed')),
  due_date     date,
  private      boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  UNIQUE (project_id, kind, number)
);
CREATE TABLE correspondence_recipients (
  correspondence_id uuid NOT NULL REFERENCES correspondence(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at   timestamptz,
  PRIMARY KEY (correspondence_id, user_id)
);

CREATE TABLE direct_costs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('invoice','expense','payroll','subcontractor_invoice')),
  cost_date     date NOT NULL,
  vendor        text,
  reference     text,
  description   text NOT NULL,
  cost_code_id  uuid NOT NULL REFERENCES cost_codes(id) ON DELETE RESTRICT,
  amount        numeric(14,2) NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX direct_costs_project ON direct_costs (project_id, cost_code_id);

CREATE TABLE tm_tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number          int NOT NULL,
  work_date       date NOT NULL,
  description     text NOT NULL,
  company         text,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  signed_by       text,
  signed_at       timestamptz,
  change_event_id uuid REFERENCES change_events(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE TABLE tm_ticket_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL REFERENCES tm_tickets(id) ON DELETE CASCADE,
  seq          int NOT NULL,
  category     text NOT NULL CHECK (category IN ('labor','material','equipment')),
  description  text NOT NULL,
  quantity     numeric(12,2) NOT NULL CHECK (quantity >= 0),
  unit         text,
  rate         numeric(14,2) NOT NULL CHECK (rate >= 0),
  cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL
);

CREATE TABLE equipment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL,
  category     text,
  ownership    text NOT NULL DEFAULT 'owned' CHECK (ownership IN ('owned','rented','subcontractor')),
  identifier   text,
  hourly_rate  numeric(14,2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  status       text NOT NULL DEFAULT 'on_site' CHECK (status IN ('on_site','off_site','down')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE TABLE equipment_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id  uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  log_date      date NOT NULL,
  hours_operated numeric(5,2) NOT NULL DEFAULT 0 CHECK (hours_operated BETWEEN 0 AND 24),
  hours_idle    numeric(5,2) NOT NULL DEFAULT 0 CHECK (hours_idle BETWEEN 0 AND 24),
  cost_code_id  uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
  notes         text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (hours_operated + hours_idle <= 24)
);
CREATE INDEX equipment_logs_by_day ON equipment_logs (equipment_id, log_date);
`,
  },
  {
    id: "0021_closeout_coordination",
    sql: /* sql */ `
-- Action plans (closeout and other checklists), warranties, coordination issues, payroll export lock.
ALTER TABLE timesheet_entries ADD COLUMN exported_at timestamptz;

CREATE TABLE action_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  kind        text NOT NULL DEFAULT 'general' CHECK (kind IN ('closeout','quality','safety','commissioning','general')),
  description text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE action_plan_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section      text NOT NULL DEFAULT 'General',
  seq          int NOT NULL,
  title        text NOT NULL,
  assignee_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date     date,
  requires_file boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','not_applicable')),
  notes        text,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz
);
CREATE INDEX action_plan_items_plan ON action_plan_items (plan_id, seq);

CREATE TABLE warranties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item        text NOT NULL,
  company     text NOT NULL,
  spec_section text,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  contact     text,
  notes       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE TABLE coordination_issues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number       int NOT NULL,
  title        text NOT NULL,
  description  text,
  type         text NOT NULL DEFAULT 'clash' CHECK (type IN ('clash','design','constructability','missing_information','other')),
  priority     text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','ready_for_review','closed')),
  assignee_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date     date,
  location     text,
  clash_run_id uuid REFERENCES clash_runs(id) ON DELETE SET NULL,
  elements     jsonb NOT NULL DEFAULT '[]',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  UNIQUE (project_id, number)
);
`,
  },
  {
    id: "0022_lookahead",
    sql: /* sql */ `
-- Lookahead tasks: short-interval work broken out under master-schedule activities.
CREATE TABLE lookahead_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  schedule_item_id uuid REFERENCES schedule_items(id) ON DELETE SET NULL,
  name             text NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  company          text,
  assignee_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  crew_size        int CHECK (crew_size BETWEEN 0 AND 10000),
  status           text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','done','blocked')),
  constraint_note  text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX lookahead_tasks_window ON lookahead_tasks (project_id, start_date, end_date);
`,
  },
  {
    id: "0023_crews",
    sql: /* sql */ `
-- Field workers without logins, project crews, and foreman-entered crew time.
CREATE TABLE workers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  employee_number text,
  trade           text,
  company         text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workers_employee_number ON workers (org_id, lower(employee_number)) WHERE employee_number IS NOT NULL;

CREATE TABLE crews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  foreman_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE TABLE crew_members (
  crew_id   uuid NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  PRIMARY KEY (crew_id, worker_id)
);

ALTER TABLE timesheet_entries ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE timesheet_entries ADD COLUMN worker_id uuid REFERENCES workers(id) ON DELETE CASCADE;
ALTER TABLE timesheet_entries ADD COLUMN entered_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE timesheet_entries ADD CONSTRAINT timesheet_one_person CHECK ((user_id IS NULL) <> (worker_id IS NULL));
UPDATE timesheet_entries SET entered_by = user_id;
`,
  },
  {
    id: "0024_saved_reports",
    sql: /* sql */ `
-- Saved custom reports (per company; optionally pinned to one project).
CREATE TABLE saved_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  dataset     text NOT NULL,
  config      jsonb NOT NULL,
  shared      boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_reports_org ON saved_reports (org_id);
`,
  },
  {
    id: "0025_drawing_annotations",
    sql: /* sql */ `
-- In-app drawing markups: one personal layer per user per revision, optionally published to the project.
CREATE TABLE drawing_annotations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id  uuid NOT NULL REFERENCES drawing_revisions(id) ON DELETE CASCADE,
  author_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shapes       jsonb NOT NULL DEFAULT '[]',
  published_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (revision_id, author_id)
);
`,
  },
  {
    id: "0026_subcontract_compliance",
    sql: /* sql */ `
-- Subcontractor invoicing contacts, insurance/compliance documents and lien waivers on commitments.
CREATE TABLE contract_contacts (
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (contract_id, user_id)
);
ALTER TABLE contracts ADD COLUMN require_insurance boolean NOT NULL DEFAULT false;
ALTER TABLE contracts ADD COLUMN require_lien_waivers boolean NOT NULL DEFAULT false;

CREATE TABLE compliance_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('general_liability','workers_comp','auto','umbrella','w9','license','other')),
  carrier     text,
  policy_number text,
  limit_amount numeric(14,2),
  effective_on date,
  expires_on  date,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  note        text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_on IS NULL OR effective_on IS NULL OR expires_on >= effective_on)
);
CREATE INDEX compliance_documents_contract ON compliance_documents (contract_id);

CREATE TABLE lien_waivers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('conditional_progress','unconditional_progress','conditional_final','unconditional_final')),
  amount      numeric(14,2) NOT NULL CHECK (amount >= 0),
  through_date date NOT NULL,
  status      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','received','accepted','rejected')),
  received_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, kind)
);
`,
  },
  {
    id: "0027_photos_dailylog_sections",
    sql: /* sql */ `
-- Photo albums and metadata; structured daily log sections.
CREATE TABLE photo_albums (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE TABLE photo_meta (
  file_id     uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  album_id    uuid REFERENCES photo_albums(id) ON DELETE SET NULL,
  caption     text,
  location    text,
  tags        text[] NOT NULL DEFAULT '{}',
  taken_at    timestamptz
);
CREATE INDEX photo_meta_album ON photo_meta (project_id, album_id);

CREATE TABLE daily_log_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id       uuid NOT NULL REFERENCES daily_logs(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('delivery','call','safety_violation','quantity','waste')),
  at_time      text CHECK (at_time IS NULL OR at_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  party        text,
  description  text NOT NULL,
  quantity     numeric(14,2),
  unit         text,
  cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX daily_log_entries_log ON daily_log_entries (log_id, kind);
`,
  },
  {
    id: "0028_permission_templates",
    sql: /* sql */ `
-- Permission templates: per-tool access levels layered on a member's project role.
CREATE TABLE permission_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  levels      jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
ALTER TABLE project_memberships ADD COLUMN template_id uuid REFERENCES permission_templates(id) ON DELETE SET NULL;
`,
  },
  {
    id: "0029_forms",
    sql: /* sql */ `
-- Forms: company form templates with typed fields, filled in per project.
CREATE TABLE form_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  fields      jsonb NOT NULL,
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE forms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template_id  uuid NOT NULL REFERENCES form_templates(id) ON DELETE RESTRICT,
  number       int NOT NULL,
  title        text NOT NULL,
  fields       jsonb NOT NULL,
  answers      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  submitted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  submitted_at timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
`,
  },
  {
    id: "0030_estimating",
    sql: /* sql */ `
-- Estimating: company cost catalog and project estimates.
CREATE TABLE cost_catalog_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code        text,
  name        text NOT NULL,
  category    text NOT NULL DEFAULT 'material' CHECK (category IN ('labor','material','equipment','subcontract','other')),
  unit        text NOT NULL,
  unit_cost   numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE TABLE estimates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  overhead_pct   numeric(6,3) NOT NULL DEFAULT 0 CHECK (overhead_pct BETWEEN 0 AND 100),
  contingency_pct numeric(6,3) NOT NULL DEFAULT 0 CHECK (contingency_pct BETWEEN 0 AND 100),
  profit_pct     numeric(6,3) NOT NULL DEFAULT 0 CHECK (profit_pct BETWEEN 0 AND 100),
  bond_pct       numeric(6,3) NOT NULL DEFAULT 0 CHECK (bond_pct BETWEEN 0 AND 100),
  sent_to_budget_at timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
CREATE TABLE estimate_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id  uuid NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  seq          int NOT NULL,
  cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
  description  text NOT NULL,
  category     text NOT NULL DEFAULT 'material' CHECK (category IN ('labor','material','equipment','subcontract','other')),
  quantity     numeric(14,3) NOT NULL CHECK (quantity >= 0),
  unit         text,
  unit_cost    numeric(14,2) NOT NULL CHECK (unit_cost >= 0)
);
`,
  },
  {
    id: "0031_cash_flow",
    sql: /* sql */ `
-- Cash-flow forecasting: how each cost code's estimate at completion spreads over months.
ALTER TABLE budget_lines ADD COLUMN spread_start date;
ALTER TABLE budget_lines ADD COLUMN spread_end date;
ALTER TABLE budget_lines ADD COLUMN spread_curve text NOT NULL DEFAULT 'linear' CHECK (spread_curve IN ('linear','front','back','s_curve'));
ALTER TABLE budget_lines ADD CONSTRAINT spread_order CHECK (spread_start IS NULL OR spread_end IS NULL OR spread_end >= spread_start);
`,
  },
  {
    id: "0032_project_emails",
    sql: /* sql */ `
-- Project emails: outbound mail sent from a project, inbound replies, threads.
CREATE TABLE project_emails (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_number int NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('outbound','inbound')),
  from_address  text NOT NULL,
  to_addresses  text[] NOT NULL DEFAULT '{}',
  cc_addresses  text[] NOT NULL DEFAULT '{}',
  subject       text NOT NULL,
  body          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('sent','failed','logged','received')),
  error         text,
  sent_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_emails_thread ON project_emails (project_id, thread_number, created_at);
CREATE TABLE project_email_files (
  email_id uuid NOT NULL REFERENCES project_emails(id) ON DELETE CASCADE,
  file_id  uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (email_id, file_id)
);
ALTER TABLE projects ADD COLUMN inbound_email_token_hash text;
`,
  },
  {
    id: "0033_takeoff",
    sql: /* sql */ `
-- Takeoff: scale calibration per sheet revision and measured quantities.
CREATE TABLE takeoff_scales (
  revision_id  uuid PRIMARY KEY REFERENCES drawing_revisions(id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Real-world units per sheet unit along x and y (sheet coordinates are fractions 0..1 of width/height).
  units_per_x  double precision NOT NULL CHECK (units_per_x > 0),
  units_per_y  double precision NOT NULL CHECK (units_per_y > 0),
  unit         text NOT NULL CHECK (unit IN ('ft','m')),
  set_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  set_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE takeoff_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id  uuid NOT NULL REFERENCES drawing_revisions(id) ON DELETE CASCADE,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('length','area','count')),
  points       jsonb NOT NULL,
  quantity     numeric(16,3) NOT NULL,
  unit         text NOT NULL,
  cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX takeoff_items_project ON takeoff_items (project_id, revision_id);
`,
  },
];
