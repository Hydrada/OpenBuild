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
];
