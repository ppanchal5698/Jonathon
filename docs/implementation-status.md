# Implementation status

Last updated: 17 Nov 2026, 4:23 PM IST.

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
| Automatic drafting on upload: requirements, linked open questions, conflicts (incl. against existing requirements), change proposals for existing requirements, near-duplicate skipping | fixture-tested + **live-verified** in the browser | `review.test.ts`; QA run below |
| Review actions: approve-in-one-step, accept question/conflict, accept-and-apply proposal (content-changed check), reject/dismiss/withdraw, delete with tombstone and no ID reuse | fixture-tested + browser e2e | `review.test.ts`, `e2e/jonathon.spec.ts` |
| Durable jobs: leases, retries with backoff, cancel, retry, restart recovery, per-conversation serialization | fixture-tested | services "durable operation" |
| MCP Streamable HTTP, 11 tools (4 read-only document and memory-graph tools added), scopes, idempotency, pending-job polling, revocation, access log | fixture-tested with a **real MCP SDK client** | server tests |
| Next.js UI: setup, dashboard, projects, review queue, documents (per-document AI draft summary), extraction preview, structured editor, approvals, conflicts, questions, proposals, diff, chat with evidence drawer, MCP, operations | built + browser e2e | `e2e/jonathon.spec.ts` |
| Project memory graph: structural graph, concept mapping (`jonathon-graph`) with name and quote gates, mentions by code, removal on source deletion, communities, search / neighbourhood / path, graphify-format `graph.json` | fixture-tested + **live-verified** (8 real documents) + read by graphify 0.9.53 CLI | `documents.test.ts`; journal 19 Nov |
| Generated technical documents: 66-type catalogue, compiled sections, writer + code gate + verifier, basis labels, debounced refresh on add/remove/knowledge change, human-edit protection, external Markdown edit kept, per-revision approval | fixture-tested + e2e (generate, edit, approve) + **live-verified** (25 must-haves on 8 real documents) | `documents.test.ts`, `e2e/jonathon.spec.ts`; journal 19 Nov |
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
| Upload-driven drafting with the extended schema (`requirement_updates`), through the UI | pass: a sign-up brief gave 4 requirements and 3 questions ("several failed attempts" became a question); a later security addendum gave a conflict against approved REQ-003 (8 vs 12) and a proposal to extend approved REQ-002, with no duplicate requirements. About 30–40 s per document |
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

* **20 Nov 2026, 1:40–3:00 PM IST**: Docker Compose deployment (demo mode) and queue/storage hardening; audit in
  [deployment-audit.md](deployment-audit.md), guide in [docker.md](docker.md). Added: lease-fenced commits, owner-checked
  `fail`/`complete`, jittered exponential backoff, per-job deadlines, admission limit, dead letters + audited replay,
  business dedupe keys, HTTP Idempotency-Key, import-root allowlist, data-marker guard, verified backup/restore with manifest.
  Results: 129 tests pass (27 new); fresh-volume Compose stack passes 27/27 smoke checks; restore into a new volume
  preserved all records; SQLite on a Docker Desktop bind mount starved a concurrent writer (8 vs 20,949 commits), so
  the default is a Docker volume. Live AI in containers is blocked (agy keyring sign-in, unverified Linux build).

## Next concrete steps

1. Parth: connect a real Claude Code session (docs/claude-code.md) and confirm `list_projects` and `get_feature_spec`.
2. Decide the answer reasoning effort (`AGY_EFFORT`); answers take 36–75 s at the CLI default.
3. Optional OCR adapter (Tesseract) for `needs_ocr` files.
4. Evaluate retrieval quality on a real client corpus before considering embeddings.
5. Add claim-support evaluation fixtures with real model output (beyond quote provenance).
* **8:20–8:40 PM**: manual end-to-end pass in the browser against an isolated QA instance (`scripts/qa.mjs`; fresh data,
  real agy 1.5.9). Verified: setup, dashboard, demo seed, documents, paste, xlsx locators, byte-exact original download,
  AI draft review (server-decided basis labels, approval blocked until proposed statements are reviewed), reject,
  approve, diff, conflict resolution into DEC-002, real cited answers and follow-ups, evidence drawer, MCP credential
  create/rotate/access log, runtime auth check, reconcile of external edits (approval revoked), rebuild index, backup.
  Fixed: chat losing the pending job when the first question creates a conversation (now resumes from the server on any
  reload); stale review form and error after a transition; AI-statement box on rejected items; dark-mode hover making a
  button unreadable; prompt-internal E-ids leaking into conflict/inference text; readiness counting blockers from other
  features; MCP token rotation dropping the expiry (security); seed racing a running worker into AI extraction; raw JSON
  in Operations; stale job progress text; paste without feedback; unlabelled file input; plain-text entity IDs (now links).
  Known, not fixed: AI extraction can propose near-duplicates of existing requirements (dedupe is by exact title only).
* **9:00 PM**: UI redesigned with TailAdmin's design system (MIT; see THIRD_PARTY_NOTICES.md), implemented natively with no new
  dependencies: class-based light/dark/auto theme without flash, collapsible sidebar (projects with their sections, system
  pages, live status widget) and mobile drawer, sticky header with Ctrl+K project search, theme toggle and account menu,
  breadcrumbs, metric tiles, bordered tables, pill tabs, split-screen sign-in, drag-and-drop upload, chat bubbles.
  Also fixed during review: Markdown headings and lists mixed with text (rendered raw before), missing accessible
  names on sidebar and account controls, cramped MCP credentials table, and the demo seed still racing a separately
  running worker (it now waits for every ingest job before enabling AI).
* **9:05–9:37 PM**: uploads now become a review queue. With AI processing on (the new-project form asks, ticked by default),
  each upload is drafted into requirements with descriptions, open questions (requirement-level ones become linked
  QUESTION items), conflicts (also against existing requirements) and change proposals for existing requirements. New
  **Review** tab with Approve / Edit / Reject / Delete per item and confirmation dialogs; structured editor replaces the JSON
  editor; Documents shows what was drafted per document; delete is tombstoned (history kept, ID never reused, never
  re-imported). The near-duplicate issue above is addressed (token-overlap matching against all existing items, and updates
  to existing requirements go through proposals). Found and fixed while testing: the fixture CLI rejected the extractor agent,
  so fixture extraction had silently failed in tests; review dialogs focusing the close icon; Edit still offered while
  editing. Final: 74 unit/integration, 1 e2e (now covering the review flow), lint, typecheck and build pass; live agy
  drafting verified through the browser on the QA instance.
* **9:45–10:14 PM**: accuracy evaluation on a real 8-document client corpus (two versions of a requirements document,
  a proposal deck, an identity setup guide, a brief, an estimate, a project tracker and a delivery plan; processed on the
  isolated QA instance, real agy 1.5.9). Scored against a hand-built checklist of the 89 numbered requirements, 10
  open questions and the cross-document disagreements. First run: 83% of numbered requirements covered, but 68 of 87
  "requirements" were tasks from plans and estimates, 2 of 350 statements labelled client-stated, 46 change proposals,
  parallel drafting races producing duplicate questions and proposals, and a false conflict between two different
  applications. Chat answers: 8 of 8 factually correct, all quotes verified, both real conflicts surfaced, the
  unanswerable question refused. Fixed: statement basis now ignores case and sentence punctuation (word-bounded);
  drafting is serialized per project; spreadsheets use the real header row (not a merged title), keep row merges once and
  column merges per row, keep true row numbers, and round float noise; merged chunks report a bounding cell range
  (citations previously showed only the first block's range); the prompt separates delivery documents from requirement
  documents, keeps client requirement IDs (one requirement per numbered item), and only reports conflicts within the
  same system; smaller batches; the existing-requirements list is ranked by relevance; paraphrased duplicate questions
  and already-proposed statements are skipped (numbers and client IDs never merge). Second run: 100% of numbered
  requirements covered (72 as their own requirement, the rest in proposals), 0 requirements from plans, 137 of 197
  statements client-stated, 23 proposals, no duplicate requirements. Still open: disagreements between two documents
  that are not requirement documents (for example a tracker vs a spec on database or framework) are no longer detected
  once plans stop producing requirements; an open question answered by a later document is not linked to that answer;
  DOCX equations are extracted twice by mammoth in one file; answers take 50–220 s under load.
* **17 Nov 2026, 2:35 PM IST**: cross-document conflict detection. Each drafting batch now sees up to 8 related passages
  from the project's other documents (lexical search on distinctive terms plus per-topic searches for technology and
  timeline words), usable only for conflicts; the drafted document is always side 1 and each side names its document;
  conflict excerpts show the matching lines. Third run on the same 8-document corpus (plans uploaded before the spec):
  88 of 89 numbered requirements as their own item, 0 duplicate questions (13 total), 10 conflicts of which 8 are real
  cross-document disagreements (login provider, technology stack, review turnaround, dependency due dates) and 2 are
  low-value (document author line; a placeholder "X%" that the spec answers with 15%). A targeted run with the tracker
  drafted before the spec found the FastAPI/React/PostgreSQL vs .NET/Angular/Azure SQL clash it had missed. Still open:
  an open question answered by a later document is not linked to that answer; one RUD open question (external log-ins)
  was not raised; DOCX equations duplicated in one file. Tests: 80 unit/integration, 1 e2e, 4 live, lint, typecheck pass.
* **17 Nov 2026, 4:23 PM IST**: multi-agent workflow (docs/architecture.md, "Agent team"): classifier, four parallel specialists, a
  code gate for numbers and client IDs, a fail-closed draft verifier, and a claim verifier for answers. Live run on the
  same 8-document corpus: all 8 document kinds classified correctly; 89 of 89 numbered requirements covered (87 as
  their own item, no duplicate IDs); all 10 of the spec's own open questions raised (the "external log-ins" one was
  missed before); 18 conflicts including the spec's internal "landed cost with or without burden" inconsistency that
  no earlier run found; the verifier checked 234 candidates and removed 4 with reasons (for example a conflict between
  two different processes), the code gate removed 2 conflicts with numbers not in their evidence. A 20-statement spot
  check found 17 faithful rewordings and 3 small invented details (labelled AI-inferred); the specialist and verifier
  prompts were tightened for invented preconditions, implementation details and dropped options, and a re-run on two
  documents went from many inferred preconditions to 3 and removed "PDF or Excel" where the source says "PDF, Excel or
  email". Answers: 8 of 8 correct after retrieval was changed to always include source passages (the freight question
  had answered "unknown" when derived drafts crowded the source table out of the context); 1 unsupported concluding
  claim removed by the answer verifier. Still open: the question specialist raises many logistics questions from
  dependency lists ("When will X provide Y?"), and paraphrased duplicates that differ by a number are kept.
  Tests: 90 unit/integration, e2e and 4 live pass.
* **19 Nov 2026, 2:12 PM IST**: technical documents and the project memory graph (docs/architecture.md, "Project memory
  graph" and "Generated technical documents"). A 66-document catalogue in 10 categories (25 must-haves); compiled
  sections from knowledge and the graph, written sections from a technical-writer agent behind a code gate and a
  document verifier; every item labelled by basis; debounced refresh when material is added or removed or knowledge
  changes, only for documents whose inputs changed; human-edited sections never overwritten (regenerated content waits);
  per-revision approval. The graph links documents, passages, knowledge, concepts and generated documents; concepts and
  AI-labelled relations need their name / a verbatim quote in a cited passage; written to `graph/graph.json` in
  graphify's format. Live run on the same 8-document corpus (QA copy, real agy 1.5.9): 8 of 8 documents mapped, 557
  nodes, about 2,000 links, 99 concepts merged across documents; graphify 0.9.53 read the file (`god-nodes`, `explain`,
  `path --undirected`, `query`). Fixes from the run: relations are now checked against all concepts of the document
  (the estimate went from 16 rejected items to 7); the graph prompt now asks for data objects and glossary terms (the
  requirements documents went from 42 to 78 concepts, including glossary terms and data objects). All 25 must-have
  documents generated; the first run had 11 writer timeouts at 240 s with 4 in parallel, so the writer now gets 600 s;
  open items per document were cut from about 50 to 1–17 (two topic words required); prompt-internal evidence ids
  ("(E3, E4)") are stripped from document text. Spot checks: the authentication design raises the open choice between
  two identity providers as a gap citing the recorded conflict and states the sign-in details from the setup guide
  correctly; the tech stack flags the two competing stacks; the data dictionary keeps the client's field limits,
  surcharges and multipliers verbatim and marks every data type as proposed. Still open: the verifier sometimes removes
  legitimate engineering proposals (Redis cache, CI rows) as "not in the evidence"; one concept community dominates
  (label propagation on a hub-heavy graph); the other 41 documents were not generated live. Tests: 99 unit/integration,
  e2e (generate, edit, approve a document; memory graph search) pass.
* **19 Nov 2026, 3:53 PM IST**: folder import (docs/architecture.md, "Folder import"). The Documents tab takes an absolute folder path,
  scans it (new / changed / unchanged / duplicate / skipped with reasons, grouped by sub-folder, nothing read into
  Jonathon), lets the person untick sub-folders or files, and imports the rest in an `import_folder` background job
  through the normal upload path. Re-importing adds only new files and new revisions of changed ones. Human session
  only; links and junctions are never followed; Jonathon's data root and source repository are refused. Real scan of a
  client folder with code and a knowledge base: 945 importable documents (739 MB) in about 15 s, 339 skipped (tooling
  folders, unsupported types). Tests: 102 unit/integration pass (3 new).
