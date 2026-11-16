# Implementation status

Last updated: 16 Nov 2026, 8:02 PM IST.

Legend: **Live-verified** = exercised against the real `agy` 1.5.9 or a real MCP SDK client on this machine.
**Fixture-tested** = automated tests through real code paths with recorded or fake inputs (no network).
**Built** = implemented, typechecked, reachable in the UI or API, without a dedicated automated test.
**Blocked** = needs Parth's action. **Not done** = not implemented.

## Phase summary

| Phase | Scope | State |
|---|---|---|
| 0 Discovery | environment, CLI and SDK contracts, ADRs, scaffold, migrations, logging, CI | done |
| 1 Vertical slice | account → project → upload → preserve → extract → index → real `agy` answer with citations → MCP `ask_jonathon` via a real MCP client | done (live `agy` + real MCP client, verified separately; see "Live verification") |
| 2 Durable operation | conversations, explicit runtime session mapping, rebuilt-context fallback, durable jobs, cancellation, restart recovery | done (fixture-tested; live resume verified) |
| 3 Requirements governance | drafts, AI draft extraction, human review, approval events, decisions, conflicts, open questions, revision history and diff | done |
| 4 Document breadth | PDF, DOCX, CSV, XLSX, JSON, HTML, PPTX, EML; OCR not configured | done except OCR |
| 5 Developer workflow | all MCP read tools, feature specs, proposals, scoped/rotating/revocable tokens, access log, Claude Code docs | done |
| 6 Hardening | external-edit reconciliation, staleness, backup/restore, security evaluation, e2e, production build | done; see open items |

## Feature matrix

| Area | State | Evidence |
|---|---|---|
| Local account, sessions, CSRF, Host/Origin checks | fixture-tested | `apps/server/test/server.test.ts` |
| Filesystem `KnowledgeStore` (atomic writes, create-only history, intents, revision checks) | fixture-tested | `packages/core/test/storage.test.ts` |
| Path traversal / junction escape protection | fixture-tested | storage tests |
| Approvals bound to revision + semantic hash; typed `status: approved` rejected | fixture-tested | storage tests |
| External-edit reconciliation (drafts, approved items, missing and invalid files) | fixture-tested | storage tests |
| Projection rebuild from files (approvals survive via approval events) | fixture-tested | services "search projections can be rebuilt" |
| Ingestion: TXT, MD, PDF, DOCX, XLSX, CSV, JSON, HTML, PPTX, EML with locators | fixture-tested | `ingestion.test.ts` |
| Parser isolation (worker thread, timeout, heap limit, zip-bomb and macro refusal) | fixture-tested | ingestion tests |
| Dedup by content hash, immutable source revisions | fixture-tested | services tests |
| FTS5 project-scoped retrieval, exact-ID lookup, current-revision filter | fixture-tested | services tests |
| `AntigravityCliRuntime`: flags, stdin NDJSON, scrubbed env, clean workspace | fixture-tested + **live-verified** | runtime tests; `antigravity.live.test.ts` |
| Tool-free agents (`tools: [finish]`) + session deny rules + stream guard | **live-verified** (probes) + fixture-tested | compatibility.md |
| Exit 0 + denial / tool attempt / wrong agent / wrong mode → typed failure | fixture-tested | runtime + services "7." |
| Process-tree cancellation (Windows `taskkill /T`) and timeouts | fixture-tested | runtime "cancellation terminates the whole process tree" |
| Explicit `--conversation` resume; silent replacement detected | **live-verified** resume; fixture-tested mismatch | live + services |
| Answer pipeline: authority labels, citation validation, verbatim quote check, readiness rules | fixture-tested + **live-verified** model output | services tests, live test |
| Draft extraction (flat schema, server-decided statement basis, conflicts need two sides) | fixture-tested + **live-verified** | live probe / live test |
| Durable jobs: leases, retries with backoff, cancel, retry, restart recovery, per-conversation serialization | fixture-tested | services "durable operation" |
| MCP Streamable HTTP, 7 tools, scopes, idempotency, pending-job polling, revocation, access log | fixture-tested with a **real MCP SDK client** | server tests |
| Next.js UI: setup, dashboard, projects, documents, extraction preview, knowledge review, approvals, conflicts, questions, diff, chat with evidence drawer, MCP, operations | built + browser e2e | `e2e/jonathon.spec.ts` |
| `pnpm run doctor`, `seed:demo`, `db:migrate`, `runtime-probe` | built | run manually |
| Backup (VACUUM INTO + projects copy) | fixture-tested | services "backups" |
| OCR for images and scanned PDFs | **not done**: Tesseract not installed; files are marked `needs_ocr` | |
| Audio/video transcription | **not done** (by design); upload transcripts as text | |
| Encryption at rest | **not done**; documented | |
| Embeddings / semantic retrieval | **not done** (deferred until the lexical baseline is evaluated) | |

## Live verification (real `agy` 1.5.9, fictional content only)

| Check | Result |
|---|---|
| Installed, flags present, authenticated (`agy models`) | pass |
| Tool-free answer with schema-valid structured output, citations to supplied evidence, injected "say 1 hour" not followed, readiness not claimed | pass |
| Follow-up via `--conversation <uuid>` keeps the same conversation | pass |
| Draft extraction finds the 8-vs-12 conflict without choosing a side | pass with `AGY_EXTRACTION_EFFORT=low` (about 14 s). At the CLI default effort it produced no output within 4 minutes (3 runs) |
| `--settings` deny rules block `run_command` | pass (probe) |
| `search_web` NOT blocked by deny rules alone; blocked by the `tools: [finish]` agent | observed (probe), hence the agent restriction |
| Workspace `AGENTS.md` is loaded as rules | observed (probe), hence empty workspaces |
| Unknown `--agent` fails closed; unknown `--conversation` silently starts a new conversation | observed (probe) |
| **Full Phase 1 slice** (`scripts/live-mcp-check.ts`): real API + worker processes in live mode, upload of 2 fictional files, worker extraction, automatic AI draft extraction (created QUESTION-001 from the email), official MCP client `ask_jonathon` → `pending` → `get_job` | pass: answer in 75 s, status `partially_answered`, expiry reported unknown, 3/3 quotes verified, readiness false with correct reasons |
| Follow-up through MCP with `conversation_id` | pass: same conversation, runtime resumed (no rebuild), refused to call expiry implementable |

All suites as of 8:01 PM IST: `pnpm test` 66/66, `pnpm test:live` 4/4, `pnpm test:e2e` 1/1 (system Edge), `pnpm lint` clean,
`pnpm typecheck` clean, `pnpm build` succeeds.

Not live-verified: Claude Code itself connecting to `/mcp`. The endpoint was verified with the official MCP client SDK
and the `claude mcp add` syntax is from the docs, but no Claude Code session was run against it here.

## Blocked / needs Parth

* **Claude Code end-to-end**: create a token in the UI, then run the `claude mcp add` command in docs/claude-code.md and ask `list_projects`.
* **OCR**: install Tesseract and decide whether to add an OCR adapter (sends nothing off-machine).
* Review whether to run answers at a lower effort too (`AGY_EFFORT`). Answers took about 36–48 s at the default.

## Known limitations

* Approvals depend on SQLite. Restoring files without the database leaves items unapproved until re-approved (by design).
* The stream guard reacts after a tool event. Prevention depends on agy honouring the agent tool list and deny rules (verified on 1.5.9 only).
* Application locks (SQLite `BEGIN IMMEDIATE`) coordinate Jonathon's own processes, not external editors. Reconciliation handles external edits.
* The CSP allows inline scripts (Next.js App Router bootstrap). There are no third-party origins.
* EML: attachments inside an email are not extracted. PPTX: text only.
* A verified quote proves provenance, not that the evidence supports the claim. Claim-support evaluation is a test category,
  not an automatic guarantee.

## Journal

* **16 Nov 2026, 6:15 PM IST**: an earlier session scaffolded contracts, migrations and config around an Obsidian vault, and verified agy 1.2.4.
* **6:35 PM**: this session found agy auto-updated to 1.5.9 and re-verified the contract. New: `--settings`, `--disable-slash-commands`,
  custom agents with `tools`. Live probes showed deny rules work, `search_web` escapes deny rules, a `tools: [finish]` agent removes all
  tools, `--mode plan` is ignored with slash commands disabled, workspace `AGENTS.md` loads as rules, and an unknown conversation ID silently forks.
* **6:50 PM**: ADR 0002, Jonathon-owned filesystem storage replacing Obsidian. Approvals bound to content hash. Tool-free agents.
* **7:00–7:20 PM**: core (storage, jobs, runtime, ingestion, retrieval, services, MCP) and 55 core tests. Fixed: readiness from raw evidence,
  config-hash timing for resume, follow-up retrieval (previous question plus refreshed previous evidence), and rebuild treating Jonathon's own files as edits.
* **7:20 PM**: Fastify API + MCP endpoint. 11 server tests with the official MCP client, all passing.
* **7:25 PM**: first live run: 3 of 4 passed. Extraction hung. Bisect (runtime-probe) ruled out schema size, depth and the conflicts sub-schema,
  then found reasoning effort: at `--effort low` it returned in 14 s. Flattened the extraction schema anyway and moved statement-basis
  decisions server-side. Added a separate tool-free extractor agent.
* **7:45 PM**: Next.js UI, scripts, docs, Playwright e2e.
* **7:55 PM**: e2e found three real UI bugs: polling that never restarted after an upload, `Badge` stringifying arrays, and an effect
  returning the Promise that Edge's `scrollIntoView` now returns. All three fixed; e2e passes. Live Phase 1 slice through MCP passes
  (see above). Answer text now rewrites prompt-internal `E1` references to the answer's own `cite_N` IDs.
* **8:00 PM**: `pnpm doctor` turned out to be a pnpm 12 built-in, so the project check is `pnpm run doctor`. Removed a
  shell-spawned version check. Final: 66 unit/integration, 4 live, 1 e2e, lint, typecheck and build all pass.

## Next concrete steps

1. Parth: connect a real Claude Code session (docs/claude-code.md) and confirm `list_projects` and `get_feature_spec`.
2. Decide the answer reasoning effort (`AGY_EFFORT`); answers take 36–75 s at the CLI default.
3. Optional OCR adapter (Tesseract) for `needs_ocr` files.
4. Evaluate retrieval quality on a real client corpus before considering embeddings.
5. Add claim-support evaluation fixtures with real model output (beyond quote provenance).
