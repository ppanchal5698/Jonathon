# Operations: running, backup, restore, troubleshooting

All times in the UI are shown in IST (Asia/Kolkata), 12-hour clock.

## Processes and ports

| Process | Command | Address |
|---|---|---|
| API + MCP | `pnpm --filter @jonathon/server start` | `http://127.0.0.1:4100` (`/api/v1`, `/mcp`) |
| Worker | `pnpm --filter @jonathon/server start:worker` | none (polls SQLite) |
| UI | `pnpm --filter @jonathon/web start` | `http://127.0.0.1:3005` |

`pnpm dev` runs all three in watch mode, and `pnpm start` runs them in production mode after `pnpm build`.
Docker Compose (demo mode) is documented in [docker.md](docker.md), which also covers the job queue, dead letters, replay,
Idempotency-Key, and `pnpm backup` / `pnpm restore` (verified backups with a manifest, which also work outside Docker).

If the worker is not running, uploads stay `queued` and questions return `pending`. The dashboard shows the worker heartbeat.

## Data root layout

```
<JONATHON_DATA_DIR>            default: %LOCALAPPDATA%\Jonathon
  jonathon.sqlite (+ -wal, -shm)        live mode      [back up]
  jonathon-demo.sqlite                  demo mode
  projects/<prj_…>/                     authoritative files [back up]
    project.md
    sources/<src_…>/<rev_…>/original.<ext>, metadata.json   (immutable)
    extracted/<src_…>/<rev_…>.md, <rev_…>.locators.json
    requirements/ decisions/ open-questions/ conflicts/ proposals/   (REQ-001.md …)
    history/<HUMAN-ID>/r<n>.md          every revision, create-only
    specifications/<spec_…>.md          feature spec snapshots
  runtime-policy/                       agy session settings + JSON schemas (regenerated)
  runtime-workspaces/<prj_…>/           empty agy working folders (regenerated)
  staging/intents/                      crash-recovery write intents
  backups/<timestamp>/                  created by “Create backup now”
```

### What can be rebuilt

| Data | Where | Rebuildable? |
|---|---|---|
| Originals, extractions, knowledge files, history, spec snapshots | files | authoritative, so back them up |
| Search index (FTS5), knowledge projection, source metadata | SQLite | **yes**: Operations → Rebuild index / Import projects found on disk |
| Accounts, sessions, MCP token hashes, conversations and messages, jobs, audit log, **approval events**, runtime session mappings | SQLite | **no**: back up the database |

Without the database, knowledge files remain readable, but approved items show as **not approved**, because the approval
events are missing. Re-approve them in the UI. This is deliberate: a file alone cannot prove a human approval.

## Backup

* UI: Operations → **Create backup now**. API: `POST /api/v1/ops/backup`. It writes `backups/<timestamp>/jonathon.sqlite`
  (consistent copy via `VACUUM INTO`) and a copy of `projects/`.
* Manual alternative: stop the API and worker, then copy `jonathon.sqlite*` and `projects/`.
* Backups are **not encrypted**. Store them on encrypted media. They keep deleted documents until you delete the backup.

## Restore

1. Stop the API, worker and UI.
2. Move the current `jonathon.sqlite*` and `projects/` aside (do not delete them until the restore is verified).
3. Copy `backups/<timestamp>/jonathon.sqlite` to `<data>/jonathon.sqlite` and `backups/<timestamp>/projects` to `<data>/projects`.
4. Start Jonathon and open Operations, then select **Reconcile files**. Files written after the backup's database snapshot are
   re-imported. Any whose content changed since approval go back to review.
5. Check the dashboard and a few approved requirements.

## External edits (Obsidian or any editor)

Knowledge files are plain Markdown with YAML frontmatter, so you can edit them in any editor.

* After editing, select **Operations → Reconcile files** (or restart the server). Draft edits become new revisions. Edits to
  approved items become new revisions **in review**, and the old approval stays attached to the old revision.
* Jonathon refuses to write an entity whose file changed since its last write (`EXTERNAL_EDIT_PENDING`) until you reconcile.
* Do not edit `id`, `human_id`, `project_id` or `entity_type`. Files with changed identity fields are reported as invalid and left alone.
* Unknown `## sections` you add are preserved verbatim.

## Deleting a document

Open the document and choose **Delete this document…**, then type `delete <name>`. This removes all revisions' originals and
extractions, their chunks and index entries, and marks dependent knowledge and answers stale. It cannot remove copies in
earlier backups, in Antigravity's transcript store (`~/.gemini/antigravity-cli/`), or at the model provider.

## Deleting a project

Open the project, go to **Settings**, choose **Delete this project…** and type `delete <project name>`
(API: `DELETE /api/v1/projects/:pid` with `{"confirmation": "delete <project name>"}`, signed-in session and CSRF token;
MCP tokens and the worker cannot do it). It removes the project folder (originals, extractions, knowledge files and
history, specifications, generated documents, graph data), its runtime workspace, and every database row of the
project: sources, search index, knowledge, approvals, conversations and answers, jobs and dead letters. MCP tokens lose
the project from their scope, and a token limited to that project is revoked. The audit log keeps a `project.deleted`
entry (who, when, name, counts; no document text). It cannot be undone, and it cannot remove copies in earlier backups,
in Antigravity's transcript store, or at the model provider.

The delete is refused while one of the project's jobs is running (the jobs are asked to stop; try again a few seconds
later). It is crash-safe: under SQLite's write lock the folders are moved to `staging/deleted-projects/<id>/` and the rows
are deleted in one transaction. If the transaction fails, the folders move back. If the process stops before the staged
folders are removed, the API or worker finishes the removal at its next start, or restores the folders when the project
still exists in the database.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `ANTIGRAVITY_NOT_INSTALLED` | `agy` is not on PATH. Install it from the official docs or set `AGY_PATH`. Check with `pnpm run doctor`. |
| `ANTIGRAVITY_AUTH_REQUIRED` | Run `agy` once in a terminal and sign in. Then select **Check authentication** on the Setup page. |
| `ANTIGRAVITY_POLICY_VIOLATION` | The runtime started a tool, a different agent, or a non-strict permission mode. Jonathon stopped it. Run `pnpm test:live` and check whether a newer `agy` changed behaviour (`pnpm run doctor` shows the version). |
| `ANTIGRAVITY_PERMISSION_DENIED` | The runtime reported denied actions. No answer was stored. Same checks as above. |
| `ANTIGRAVITY_TIMEOUT` | The run exceeded `AGY_TIMEOUT_MS`. It retries once automatically. Large extraction batches can take minutes. |
| `INVALID_MODEL_OUTPUT` | The model returned no structured output or an invalid one after the repair attempt. Retry the job. |
| Answers always `insufficient_evidence` | No indexed evidence matches. Check the documents' extraction status and run Rebuild index. |
| Jobs stuck in `queued` | The worker is not running (dashboard → System health). |
| `EXTERNAL_EDIT_PENDING` | A file was edited outside Jonathon. Run Reconcile. |
| Server refuses to start: data dir inside repository | Set `JONATHON_DATA_DIR` outside the source tree. |
| `FORBIDDEN: invalid Host header` | You opened the API with a hostname that is not in the allowlist. Use `127.0.0.1` or `localhost`, or add the origin to `JONATHON_WEB_ORIGINS`. |

Logs are structured JSON (pino) on stdout. Each response carries `X-Correlation-Id`, and errors include `correlation_id`, which you can
search for in the logs. Document text, prompts, tokens and passwords are redacted from logs.
