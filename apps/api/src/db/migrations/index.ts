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
];
