/**
 * Forward-only migrations. Each runs inside a transaction and is recorded in schema_migrations.
 * Never edit a shipped migration; add a new one.
 *
 * Authority legend used in comments:
 *   [SQLITE]     authoritative here; back up the database file.
 *   [PROJECTION] rebuildable from the data root's files (ops → reindex / reconcile).
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_initial",
    sql: `
-- [SQLITE] local accounts
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- [SQLITE] browser sessions (token stored as SHA-256 hash only)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  username TEXT NOT NULL,
  at TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0,1))
) STRICT;
CREATE INDEX login_attempts_user_at ON login_attempts(username, at);

-- [PROJECTION] of projects/<id>/project.md
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ai_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ai_enabled IN (0,1)),
  knowledge_revision INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  file_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- [PROJECTION] of sources/<source>/<revision>/metadata.json
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file','pasted_text')),
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX sources_project ON sources(project_id);

CREATE TABLE source_revisions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending','succeeded','partially_succeeded','failed','unsupported','needs_ocr')),
  extraction_warnings TEXT NOT NULL DEFAULT '[]',
  extractor TEXT,
  extracted_hash TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, revision_number),
  UNIQUE (project_id, content_hash)
) STRICT;
CREATE INDEX source_revisions_project ON source_revisions(project_id);

-- [PROJECTION] retrieval chunks for source evidence and knowledge entities
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('evidence','knowledge')),
  source_id TEXT,
  revision_id TEXT,
  entity_id TEXT,
  entity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading TEXT,
  locator TEXT NOT NULL DEFAULT '{}',
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX chunks_project ON chunks(project_id, kind);
CREATE INDEX chunks_revision ON chunks(revision_id);
CREATE INDEX chunks_entity ON chunks(entity_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, heading, title,
  chunk_id UNINDEXED, project_id UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- [SQLITE] durable job queue with leases
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retrying','succeeded','partially_succeeded','failed','cancelled','unsupported','needs_ocr')),
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  progress TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  serial_key TEXT,
  created_by TEXT NOT NULL,
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
) STRICT;
CREATE INDEX jobs_claim ON jobs(status, run_after);
CREATE INDEX jobs_project ON jobs(project_id, created_at);
CREATE INDEX jobs_serial ON jobs(serial_key, status);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  error_code TEXT,
  error_message TEXT
) STRICT;
CREATE INDEX job_attempts_job ON job_attempts(job_id);

-- [SQLITE] conversations are owned by Jonathon, not by the runtime
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','mcp_token')),
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  feature_scope TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX conversations_project ON conversations(project_id, updated_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  feature_scope TEXT,
  answer TEXT,
  status TEXT NOT NULL,
  request_id TEXT,
  job_id TEXT,
  reply_to TEXT,
  knowledge_revision INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX messages_request ON messages(conversation_id, request_id) WHERE request_id IS NOT NULL;

-- [SQLITE] evidence snapshot behind each answer (traceability and staleness)
CREATE TABLE answer_sources (
  message_id TEXT NOT NULL REFERENCES messages(id),
  project_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  revision_id TEXT,
  entity_id TEXT,
  entity_revision INTEGER,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (message_id, chunk_id)
) STRICT;
CREATE INDEX answer_sources_revision ON answer_sources(revision_id);
CREATE INDEX answer_sources_entity ON answer_sources(entity_id);

-- [SQLITE] explicit mapping Jonathon conversation -> runtime conversation. Never selected by recency.
CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  runtime_config_hash TEXT NOT NULL,
  runtime_conversation_id TEXT NOT NULL,
  knowledge_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','reset')),
  last_success_message_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX runtime_sessions_active
  ON runtime_sessions(project_id, conversation_id, provider, runtime_version, runtime_config_hash) WHERE status = 'active';
CREATE UNIQUE INDEX runtime_sessions_provider_id ON runtime_sessions(runtime_conversation_id);

-- [PROJECTION] of knowledge entity files. Authority: the file (frontmatter + sections).
CREATE TABLE knowledge_entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  entity_type TEXT NOT NULL,
  human_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  approval_event_id TEXT,
  approval_valid INTEGER NOT NULL DEFAULT 0,
  feature_scopes TEXT NOT NULL DEFAULT '[]',
  blocking INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  file_state TEXT NOT NULL DEFAULT 'ok' CHECK (file_state IN ('ok','external_edit','missing','invalid_file')),
  data TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX knowledge_project_type ON knowledge_entities(project_id, entity_type, status);
CREATE UNIQUE INDEX knowledge_human_id ON knowledge_entities(project_id, human_id);

-- [SQLITE] human approval events. An approval is valid only for the exact revision + semantic hash recorded here.
CREATE TABLE approval_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  human_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  semantic_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve','reject','resolve','answer')),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'user'),
  actor_id TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
) STRICT;
CREATE INDEX approval_events_entity ON approval_events(entity_id, revision);

-- [PROJECTION] feature specification snapshots (files under specifications/)
CREATE TABLE spec_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  feature TEXT NOT NULL,
  knowledge_revision INTEGER NOT NULL,
  approved_only INTEGER NOT NULL,
  entity_revisions TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX spec_snapshots_project ON spec_snapshots(project_id, feature);

-- [SQLITE] append-only audit log
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  project_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  correlation_id TEXT
) STRICT;
CREATE INDEX audit_project_at ON audit_events(project_id, at);
CREATE INDEX audit_entity ON audit_events(entity_id);

-- [SQLITE] MCP bearer tokens (hash only; plaintext shown once)
CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL,
  project_ids TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  rotated_from TEXT,
  last_used_at TEXT
) STRICT;

CREATE TABLE mcp_access_log (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  project_id TEXT,
  outcome TEXT NOT NULL,
  error_code TEXT,
  correlation_id TEXT
) STRICT;
CREATE INDEX mcp_access_token_at ON mcp_access_log(token_id, at);

-- [SQLITE] idempotency for MCP proposals and other non-job mutations
CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;

CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE integration_health (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
) STRICT;
`,
  },
];
