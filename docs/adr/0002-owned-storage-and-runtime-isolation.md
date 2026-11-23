# ADR 0002: Jonathon-owned storage and tool-free runtime isolation

- Status: accepted. Supersedes the storage parts of ADR 0001 (sections 3 and 4), and the runtime flags in section 5.
- Date: 16 Nov 2026
- Decider: Parth (storage ownership, from the product brief), implementation agent (details)

## Context

ADR 0001 kept authoritative knowledge in an Obsidian vault reached through the Obsidian Local REST API plugin.
The revised brief says Jonathon owns its storage and must run without Obsidian, SilverBullet, Notion or any other
knowledge application. Separately, Antigravity CLI moved from 1.2.4 to 1.5.9, and that release has verified
controls that are better than the 1.2.4 stream guard: session-only `--settings`, and custom agents with an explicit `tools` list.

## Decision 1: filesystem knowledge store plus SQLite

- The data root is configurable (`JONATHON_DATA_DIR`). It defaults to `%LOCALAPPDATA%\Jonathon` on Windows and
  `~/.local/share/jonathon` elsewhere, which keeps it outside the source repository. It is never served statically.
- **Filesystem is authoritative** for project manifests (`project.md`), immutable source revisions
  (`sources/<source>/<revision>/original.<ext>` + `metadata.json`), extraction artifacts
  (`extracted/<source>/<revision>.md` + `.locators.json`), requirements, decisions, open questions, conflicts,
  change proposals, specification snapshots and per-entity revision history (`history/<HUMAN-ID>/r<n>.md`).
- **SQLite is authoritative** for users, sessions, MCP token hashes and scopes, conversations, messages, runtime
  conversation mappings, jobs and leases, audit events and **approval events**.
- **SQLite projections are rebuildable** from files: `knowledge_entities`, `sources`/`source_revisions` metadata, `chunks` and FTS.
- Knowledge files are portable Markdown with conservative YAML frontmatter. Metadata (id, project_id, entity_type, schema_version,
  revision, status, created_at, updated_at, source_refs, supersedes, approval_event_id, ...) lives in frontmatter.
  Content lives in fixed `## Section` headings, so Obsidian or any editor can edit it.

### Approval is a database fact bound to content

An entity counts as approved only when all of these hold:

1. Frontmatter says `status: approved` **and** names `approval_event_id`.
2. That approval event exists in SQLite for the same project, entity id and revision, recorded by a human principal.
3. The event's `content_hash` equals the entity's current **semantic hash**: a hash over title, fields and sections,
   excluding status, timestamps and approval metadata.

Typing `status: approved` into a file, or editing approved text, therefore cannot create or keep an approval.

### Write protocol (no cross-store transaction is claimed)

Every application write to a knowledge file runs inside `BEGIN IMMEDIATE`. That serializes the server and worker
processes, which are the only application writers.

1. Read the file, check the expected revision and the last recorded file hash. A mismatch is `REVISION_CONFLICT`.
   A file changed outside Jonathon must be reconciled first.
2. Write an **intent record** under `staging/intents/` (target path, new file hash).
3. Copy the new revision into history, then atomically replace the target: write a temp file in the same directory, fsync, rename.
4. Update projections, approval events and audit in the same SQLite transaction, then commit.
5. Delete the intent.

A crash between 3 and 4 leaves an intent whose hash matches the file. Reconciliation finishes the projection instead
of treating Jonathon's own write as an external edit. Application locks do not protect against external editors;
reconciliation handles them.

### External edits

Reconciliation (startup, the Operations screen, or `POST /api/v1/ops/reconcile`) compares each file's hash with the
recorded one:

- Draft or in-review entity: the edit is imported as a new revision, with the same status and origin `external_edit`.
- Approved entity: the edit is imported as a new revision with `status: in_review` and no approval. The old approval stays
  attached to the old revision in history. Specifications derived from it are flagged stale.
- Deleted file: the projection is marked `missing` and surfaced in Operations. Nothing is silently deleted.
- Parse failure: the file is left untouched and reported. The last good projection is kept and marked `invalid_file`.

## Decision 2: tool-free Antigravity runs

Each run uses an empty per-project runtime workspace (`runtime-workspaces/<project>/`). Jonathon writes exactly one file
there: `.agents/agents/jonathon-reasoner.md`, a custom agent with `tools: [finish]`. That leaves only the internal step
that returns structured output. The run is invoked with:

`--agent jonathon-reasoner --settings <policy> --json-schema <schema> --sandbox --disable-slash-commands --input-format stream-json --output-format stream-json`

where the session policy denies `command`, `read_file`, `write_file`, `read_url`, `execute_url`, `mcp` and `unsandboxed`
with `toolPermission: strict`. None of this changes the user's global `agy` configuration.

The stream guard stays as a backstop. It kills the process tree on a wrong agent, a wrong permission mode, or any tool step.

`--mode plan` is dropped because 1.5.9 ignores it when slash commands are disabled.

Resume uses `--conversation <uuid>`. Because 1.5.9 silently starts a new conversation for an unknown ID, the adapter compares
`init.conversation_id` with the requested ID. On a mismatch it marks the mapping reset and adds a `runtime_context_rebuilt`
warning. That run's prompt always includes bounded history rebuilt from SQLite, so the answer is still grounded.

## Decision 3: simplified package layout

The suggested `packages/{db,storage,antigravity,ingestion,retrieval,mcp,security}` are folders inside `packages/core/src`,
each with an `index.ts` boundary (ADR 0001, section 2). The worker is a second entry point in `apps/server` that
shares the same composition root. `packages/test-fixtures` holds the fictional demo project and runtime fixtures.

## Consequences

- Jonathon runs with no third-party knowledge application.
- Backups must include **both** the data root's `projects/` tree and `jonathon.sqlite` (users, tokens, conversations,
  approvals and audit cannot be rebuilt from files). See `docs/operations.md`.
- Losing SQLite but keeping files leaves all knowledge readable, but approvals become invalid (they show as
  `in_review`, with no approval event) until Parth re-approves them. This is deliberate.
