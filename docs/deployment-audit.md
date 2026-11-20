# Docker deployment: repository audit and status

Date: 20 Nov 2026 (IST). Branch `first-release`. Source code is authoritative where the docs differed.
Operations guide: [docker.md](docker.md).

## 1. Audit before changes (what the code did)

### Already implemented

| Area | Evidence |
|---|---|
| Three processes sharing one composition root | `apps/server/src/main.ts` (Fastify API + MCP), `apps/server/src/worker.ts` (worker), `apps/web` (Next.js 16.4.5), `packages/core/src/app.ts` `createApp()` |
| Same-origin browser API | `apps/web/next.config.ts` rewrites `/api/v1/*` to `JONATHON_API_URL` (default `http://127.0.0.1:4100`); session cookie `HttpOnly; SameSite=Strict` (`apps/server/src/security.ts`) |
| Host/Origin/CSRF checks | `checkHostAndOrigin`, `requireUser` (CSRF header on every mutation), `allowedHosts` (`apps/server/src/security.ts`); `trustProxy: false` (`apps/server/src/server.ts`) |
| Loopback-only bind | `loadConfig` refuses a non-loopback `JONATHON_HOST` without `JONATHON_ALLOW_REMOTE` (`packages/core/src/config.ts`) |
| SQLite | `node:sqlite` `DatabaseSync`, WAL, `synchronous=NORMAL`, `busy_timeout=10000`, FK on, `BEGIN IMMEDIATE` writers, forward-only migrations (`packages/core/src/db/index.ts`, `db/migrations.ts`). No native addon. |
| Authority split | Migration comments mark `[SQLITE]` vs `[PROJECTION]` tables (`db/migrations.ts`); `docs/operations.md` "What can be rebuilt" |
| Durable queue with leases | `jobs`, `job_attempts`, atomic claim in one transaction, lease heartbeat, `recoverExpiredLeases`, retryable codes with fixed backoff 2 s/10 s/60 s, `serial_key`, `idempotency_key UNIQUE`, cancel, release on shutdown (`packages/core/src/jobs/queue.ts`, `jobs/worker.ts`) |
| Worker heartbeat + "worker not running" UI | `worker_heartbeats`, `OpsService.health()` (60 s staleness), `apps/web/app/page.tsx`, `apps/web/app/operations/page.tsx` |
| File + DB consistency | atomic temp+rename writes, create-only history (`storage/fsutil.ts`); write intents completed by reconciliation (`storage/knowledge-store.ts` `commit`, `completeIntents`, `reconcile`); content-hash dedupe of uploads (`UNIQUE(project_id, content_hash)`) |
| Idempotency (partial) | job `idempotency_key` for ingest/extract/graph per revision (`services/sources.ts`); `idempotency_keys` table for MCP proposals (`services/knowledge.ts`); `request_id` for ask (`services/answering.ts`) |
| Backup (partial) | `OpsService.backup`: `VACUUM INTO` + copy of `projects/` (`services/ops.ts`) |
| Reconcile / rebuild | `ops.reconcile`, `ops.rebuildIndex`, `ops.importFromFiles` (`services/ops.ts`) |
| MCP | stateless Streamable HTTP, bearer token hashed (SHA-256), scopes `read`/`propose`, project allowlist, revoke/rotate, access log (`security/auth.ts`, `mcp/server.ts`); approval paths call `assertHuman` / `can(...,"approve")` which is false for MCP and system (`security/principal.ts`) |
| AI runtime isolation | `spawn` with `shell:false`, fixed validated args, allowlisted env, empty per-project workspace, custom agent `tools:[finish]`, deny settings, `--sandbox`, NDJSON size limits, timeout, process-tree kill (`runtime/antigravity.ts`, `runtime/process-tree.ts`, `runtime/policy.ts`) |
| Folder import validation | absolute path, no links/junctions, not inside data/repo, real-path checks (`services/folder-import.ts`) |
| Graph cache | fingerprint-keyed in-process cache, recomputed from DB state (`services/graph.ts` `fingerprint`, `build`) |
| Tests | 102 passing (vitest), fake agy (`packages/test-fixtures/runtime/fake-agy.mjs`), CI `.github/workflows/ci.yml` (lint, typecheck, test) |

### Partially implemented (before this change)

| Gap | Evidence |
|---|---|
| `fail()` ignored the lease owner: a stale worker could overwrite the state of a job another worker had re-claimed | `queue.ts` `fail` updated `WHERE id = ?` only |
| Stale business commits: a handler that lost its lease still committed knowledge writes; only `complete()` checked `lease_owner` | `jobs/worker.ts` aborted the signal, but services ignored it at commit time |
| Fixed backoff without jitter; max attempts hard-coded per enqueue | `BACKOFF_MS = [2_000, 10_000, 60_000]` |
| Failed jobs kept only `error_message`; no durable dead-letter record; `retry` was not audited and not restricted to humans | `queue.retry`, `/jobs/:jid/retry` |
| No per-job deadline (only the agy timeout) | `worker.ts` |
| Expired leases recorded as `ANTIGRAVITY_UNAVAILABLE` (misleading) | `recoverExpiredLeases` |
| Backup without manifest or verification; no restore command | `ops.backup`; restore was a manual copy in `docs/operations.md` |
| Duplicate "interpret" / "map graph" clicks queued duplicate jobs | `server.ts` interpret route, `graph.queueExtraction` |
| Disk full surfaced as `INTERNAL` (not retryable) | `util.toAppError` |

### Missing (before this change)

* Dockerfiles, Compose, `.dockerignore`, container health checks, a non-root runtime user.
* A Next.js standalone build.
* Generic HTTP `Idempotency-Key` support.
* Folder-import allowlist roots (any absolute host path was accepted).
* A guard against starting on an empty data directory when a mount is missing (`openDatabase` silently `mkdir`s).
* Readiness endpoint.
* Admission limit on the queue.

### Containerization blockers found

| Blocker | Resolution |
|---|---|
| API refuses `0.0.0.0` | `JONATHON_CONTAINER=true`, honoured only when `/.dockerenv` or `/run/.containerenv` exists |
| Host allowlist rejects the proxy's `server:4100` and remapped host ports | `JONATHON_ALLOWED_HOSTS` (validated `host[:port]` list) |
| Next.js rewrites are fixed at build time | build arg `JONATHON_API_URL=http://server:4100` |
| Server runs TypeScript through `tsx` (root devDependency) | `tsx` added as a server dependency (same pinned version); `node --import tsx` |
| Folder import expects host paths | read-only `/imports` mount + `JONATHON_IMPORT_ROOTS` |
| SQLite on Docker Desktop bind mounts | measured: correct in one run but writer starved (8 vs 20,949 commits); default is a Docker volume plus backup/restore for moving data |
| **agy in Linux containers** | **Blocked.** Account sign-in uses the OS keyring; Linux install is a remote script not run here; no container verification. Demo mode is containerized; live mode stays native (hybrid). See docker.md "AI runtime". |
| Ports 3000/3005 docs drift | UI defaults moved to 3005 (`scripts/dev.mjs`, `apps/web/package.json`, `config.ts`, `.env.example`, README, docs) |

## 2. What changed

| Area | Files |
|---|---|
| Images and Compose | `Dockerfile` (targets `server`, `web`), `compose.yaml`, `.dockerignore`, `docker/compose.env.example`, `docker/empty-imports/`, `docker/backups/` |
| Config | `packages/core/src/config.ts`: `JONATHON_CONTAINER`, `JONATHON_ALLOWED_HOSTS`, `JONATHON_MCP_PUBLIC_URL`, `JONATHON_IMPORT_ROOTS`, `JONATHON_REQUIRE_EXISTING_DATA` + `assertDataDirReady`, queue settings |
| Queue | `jobs/queue.ts` (owner-checked `fail`/`complete`/`setProgress`, jittered exponential backoff, dead letters, `replay`, `dedupeKey`, admission limit, `sanitizeDiagnostic`); `jobs/worker.ts` (lease fence, deadlines, `LEASE_LOST`/`JOB_TIMEOUT`); `db/index.ts` (`leaseFence` checked in `tx()`); migration `003_queue_hardening` |
| Errors | `LEASE_LOST`, `JOB_TIMEOUT` (retryable), `IDEMPOTENCY_CONFLICT` (`packages/contracts/src/errors.ts`); disk-full → `STORAGE_UNAVAILABLE` (`util.ts`) |
| HTTP | `apps/server/src/idempotency.ts`; `server.ts`: `/api/v1/ready`, `/ops/dead-letters`, `/jobs/:jid/replay`, audited `/retry`, dedupe on interpret |
| Backup/restore | `services/backup.ts` (`createBackup`, `verifyBackup`, `restoreBackup`, `reconcileAfterRestore`); CLIs `apps/server/src/cli/{init-data,backup,restore}.ts`; `pnpm data:init`, `pnpm backup`, `pnpm restore` |
| Worker health | `JONATHON_HEALTH_FILE` in `apps/server/src/worker.ts`; health shows `deployment` and `dead_letters`; dashboard tells Docker users how to start the worker |
| Tests | `packages/core/test/reliability.test.ts` (16), `packages/core/test/backup.test.ts` (4), `apps/server/test/operations.test.ts` (7), fixture `packages/core/test/fixtures/claim-loop.ts`; `scripts/docker-smoke.ts` (27 live checks); `scripts/bench-reads.ts` |
| Docs | `docs/docker.md`, this file, `docs/architecture.md`, `docs/operations.md`, `README.md`, `docs/implementation-status.md` |

Not changed: architecture, Next.js/Fastify/TypeScript/pnpm, SQLite + files storage model, approval rules, MCP scopes.
No PostgreSQL, Redis, broker or graph database. No data deleted, no database reset, no credential rotated.

## 3. Commands executed and observed outcomes

All on the Windows 11 dev host (Docker Desktop 29.8.2, linux/amd64 engine), 20 Nov 2026 (IST).

| # | Command | Outcome |
|---|---|---|
| 1 | `pnpm test` (before changes) | 9 files, **102 passed** |
| 2 | `pnpm typecheck` (before) | passed |
| 3 | `docker buildx imagetools inspect node:24-trixie-slim` / `node:24.22.3-trixie-slim` | `NODE_VERSION=24.22.3`; index digest `sha256:af02d57b…f124a0`; amd64 + arm64/v8 present |
| 4 | `docker compose --env-file docker/compose.env build` | both images built (server 479 MB, web 392 MB) |
| 5 | `JONATHON_INIT_NEW_DATA_DIR=false docker compose … run --rm init` on a new volume | refused: "data directory /data is empty…" |
| 6 | `docker compose … up -d` | init exited 0; server, worker, web healthy (ports remapped to 3105/4105 because a local `pnpm dev` held 3005/4100) |
| 7 | `pnpm tsx scripts/docker-smoke.ts --ui http://localhost:3105 --mcp http://127.0.0.1:4105` | first run: MCP failed with `invalid Host header` on the remapped port, fixed (allowlist + `JONATHON_MCP_PUBLIC_URL`); second run **27/27 checks passed** |
| 8 | `docker compose … stop worker`, then `/ops/health` | `worker.alive=false`, `status=degraded`; worker log: `SIGTERM … stopping worker; releasing running jobs` |
| 9 | row counts, then `docker compose … down` / `up -d`, then counts again | identical (users, tokens, jobs, approvals, audit, entities, revisions, idempotency records) |
| 10 | `… --profile tools run --rm backup --out /backups/offline-1` (stack stopped), then `--verify` | ok: 172 files; migrations 001–003 |
| 11 | offline backup while the worker runs | refused: "a worker is running (fresh heartbeat)…" |
| 12 | `… backup --out /backups/online-1 --online` | ok |
| 13 | restore into a new volume: without `--yes` / with `--yes`, then `up -d` and sign in | refused without `--yes`; restored, reconciled; same counts (+1 audit event for the reconcile); same account signs in; worker alive |
| 14 | `docker inspect` of server/worker/web | uid 1000, read-only rootfs, `CapDrop=[ALL]`; web has **no** mounts (`ls /data` → no such file); ports bound to 127.0.0.1 only |
| 15 | multi-container SQLite stress (3 claimers + 1 writer, 400 jobs) on a Docker volume | 0 duplicate claims, 400/400 succeeded, 20,949 writer commits, integrity ok |
| 16 | the same on a Windows bind mount | 0 duplicates, 400/400, **8** writer commits, integrity ok |
| 17 | `pnpm tsx scripts/bench-reads.ts 200` | see docker.md "Caching decision" |
| 18 | `pnpm lint`, `pnpm typecheck`, `pnpm test` (after changes) | lint clean; typecheck clean; **12 files, 129 tests passed** |
| 19 | fresh volume `jonathon-data-final`, `JONATHON_INIT_NEW_DATA_DIR=true`, `up -d --build`, smoke | init "initialised a NEW data directory", migrations 001–003, **27/27 passed**, server/web/worker healthy |
| 20 | browser: dashboard with the worker container stopped, then started | "Stopped" + banner "Start it with docker compose up -d worker…", then "Running" with no banner |

## 4. Acceptance criteria status

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Clean checkout starts via documented Compose workflow | **Tested** (demo mode) | commands 4–6; docker.md Quick start |
| 2 | UI at localhost:3005 | **Tested on 3105** (3005 was held by the running dev server); default mapping `127.0.0.1:3005` is in `compose.yaml` | command 6–7 |
| 3 | Login, origin checks, sessions, CSRF | **Tested** through the container proxy | smoke checks; `server.test.ts` |
| 4 | Host Claude Code reaches only scoped MCP | **Tested**: scoped tools, no approve tools, bearer refused on REST, `/mcp` not via the UI, missing/revoked token 401 | smoke |
| 5 | Upload → ingestion → drafts → review → graph → documents | **Tested** (demo runtime) | smoke |
| 6 | Restart preserves bytes, revisions, accounts, tokens, conversations, jobs, approvals, audit | **Tested**: containers (command 9) and in-process with original-byte hashes (`reliability.test.ts`) | |
| 7 | Worker heartbeat and "worker not running" | **Tested** in containers: API (`alive:false`, `degraded`) and the dashboard in a browser (Worker "Stopped" + Docker-specific banner; back to "Running" after `docker compose start worker`) | command 8, 20 |
| 8 | Duplicate requests/jobs do not duplicate effects | **Tested**: Idempotency-Key, upload content-hash dedupe, job dedupe keys | `operations.test.ts`, `reliability.test.ts`, smoke |
| 9 | Crashed workers recover via leases, no stale commits | **Tested** | `reliability.test.ts` "leases and fencing" |
| 10 | Retry exhaustion → inspectable dead letters | **Tested** | `reliability.test.ts`, `operations.test.ts` |
| 11 | Replay authorized, audited, safe | **Tested** | same |
| 12 | Cache invalidation after approval, edit, rejection, deletion | **Tested** | `backup.test.ts` "cached projections" |
| 13 | Backup/restore recovers DB and documents | **Tested** in-process and in containers | `backup.test.ts`, commands 10–13 |
| 14 | Runtime isolation prevents unintended client-file access | **Partly**: existing runtime tests (empty workspace, scrubbed env, tool policy, tree kill) still pass; web container has no data mount. agy-in-container isolation is **blocked** (not containerized). | `runtime.test.ts`, command 14 |
| 15 | Existing tests pass | **Tested** | section 5 |

Untested: arm64 images; macOS and Linux hosts; Docker Desktop bind mounts on macOS; live mode in containers;
disk-full against a real full filesystem (the
classification is unit-tested only).

## 5. Final verification

Commands 18–20 above were the last runs on the final code. Test volumes created for this work were removed afterwards.
Known side effect: a `biome format --write` run during this work also reflowed lines (line wrapping and trailing commas
only) in files outside this change. See the session report for the list and the restore command.
