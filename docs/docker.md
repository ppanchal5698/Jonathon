# Running Jonathon with Docker Compose

Single host, single user, demo mode fully containerized. **Not highly available**: one SQLite file, one API, one worker
on one machine. Live AI (the Antigravity CLI, `agy`) is **not** containerized yet; see [AI runtime](#ai-runtime).
The non-Docker workflow (`pnpm dev`, `pnpm start`) is unchanged and is still the way to develop with hot reload.

## Quick start (clean checkout, demo mode)

```powershell
copy docker\compose.env.example docker\compose.env
# First start of a NEW installation only: set JONATHON_INIT_NEW_DATA_DIR=true in docker\compose.env
docker compose --env-file docker/compose.env up -d --build
docker compose --env-file docker/compose.env ps
```

Open <http://localhost:3005>, create the local account, then set `JONATHON_INIT_NEW_DATA_DIR=false` again.
Stop with `docker compose --env-file docker/compose.env down` (data stays in the volume; never add `-v` unless you mean to
delete it).

Check a running stack end to end (fictional text only; creates a test project):

```powershell
$env:JONATHON_SMOKE_PASSWORD = "<the password of the local account, or a new one for a fresh install>"
pnpm tsx scripts/docker-smoke.ts --ui http://localhost:3005 --mcp http://127.0.0.1:4100 --user <username>
```

## Services

| Service | Image (target) | Process | Host port | Mounts | Network |
|---|---|---|---|---|---|
| `init` | `jonathon-server:local` (`server`) | `src/cli/init-data.ts`, one shot | none | `/data` | none |
| `server` | `jonathon-server:local` | `src/main.ts` (Fastify: `/api/v1`, `/mcp`) | `127.0.0.1:4100` (MCP for host Claude Code) | `/data`, `/imports:ro` | default bridge |
| `worker` | `jonathon-server:local` | `src/worker.ts` | none | `/data`, `/imports:ro` | default bridge |
| `web` | `jonathon-web:local` (`web`) | Next.js standalone `server.js` | `127.0.0.1:3005` | **none** | default bridge |
| `backup` / `restore` | `jonathon-server:local` | `src/cli/backup.ts` / `restore.ts` (profile `tools`) | none | `/data`, `/backups` (`:ro` for restore) | none |

Every application container runs as a non-root user (`1000:1000` by default), with a read-only root filesystem,
`tmpfs /tmp`, `cap_drop: [ALL]`, `no-new-privileges`, and `init: true` (tini as PID 1 forwards `SIGTERM` and reaps
orphaned subprocesses). Startup order: `init` must exit 0, then `server` and `worker` start; `web` waits for `server`
to be healthy. All long-running services use `restart: unless-stopped`.

Health checks:

* `server`: `GET /api/v1/ready` (the database answers and `/data` is writable; no details are returned).
* `worker`: `/tmp/worker-health` is rewritten every 10 s only while the worker's own heartbeat row, written by its job
  loop, is fresher than 30 s. A hung job loop turns the container unhealthy.
* `web`: `GET /api/v1/health` through the UI's own proxy (proves UI → API connectivity).

Shutdown: `server` stops accepting connections and closes (`stop_grace_period: 20s`). `worker` stops claiming, aborts
running jobs (the runtime kills its process tree), releases them back to `queued` without spending an attempt, and
deletes its heartbeat row so the UI shows "worker not running" immediately (`stop_grace_period: 40s`).

## Networking

* **Inside** the Compose network the API listens on `0.0.0.0:4100`. That is allowed only when
  `JONATHON_CONTAINER=true` **and** a container marker file (`/.dockerenv` or `/run/.containerenv`) exists, so the same
  setting cannot open a bare-metal install to the network (`packages/core/src/config.ts`).
* **On the host** only loopback is published: UI `127.0.0.1:3005`, MCP `127.0.0.1:4100`. Change them with
  `JONATHON_DOCKER_UI_PORT` / `JONATHON_DOCKER_MCP_PORT`. Origins and allowed Host headers follow automatically.
* The browser talks only to the UI origin. Next.js rewrites `/api/v1/*` to `http://server:4100` (baked in at image build
  time, build arg `JONATHON_API_URL`), so the session cookie stays first-party and `SameSite=Strict`.
* The API answers only to `Host` values it knows: `127.0.0.1:<port>`, `localhost:<port>`, the configured web origins, and
  `JONATHON_ALLOWED_HOSTS` (`server:4100` for the web proxy and `127.0.0.1:<published MCP port>`). Anything else is 403
  (DNS-rebinding defence).
* `trustProxy` stays `false`. No security decision uses the client IP, and `X-Forwarded-*` headers are ignored.
  Origin, Host, session and CSRF checks are unchanged and are exercised through the proxy by `scripts/docker-smoke.ts`.
* MCP for Claude Code on the host: `http://127.0.0.1:4100/mcp` with `Authorization: Bearer jon_…` (create the token in
  the UI, scoped to projects and `read`/`propose`). `/mcp` is **not** reachable through the UI origin, and MCP tokens are
  not accepted by `/api/v1`. The same loopback listener serves `/api/v1`, which still needs a session cookie, the CSRF
  token and an allowed Origin. To disable host MCP access, drop the `ports:` entry of `server` in an override file.

## Storage

Two stores, both under `/data` and both required: the SQLite database (`jonathon-demo.sqlite` in demo mode,
`jonathon.sqlite` in live mode) and `projects/` (authoritative files). See [operations.md](operations.md#data-root-layout).

### Where `/data` lives

| Host OS | Recommended | How |
|---|---|---|
| Windows (Docker Desktop, WSL 2) | **Docker volume** (default) | `JONATHON_DOCKER_DATA_MOUNT_TYPE=volume`, `JONATHON_DOCKER_VOLUME=jonathon-data` |
| macOS (Docker Desktop) | **Docker volume** (default) | as above |
| Linux (native ext4/xfs disk) | volume, or a bind mount | `JONATHON_DOCKER_DATA_MOUNT_TYPE=bind`, `JONATHON_HOST_DATA_DIR=/home/you/.local/share/jonathon-docker`, `JONATHON_DOCKER_UID=$(id -u)`, `JONATHON_DOCKER_GID=$(id -g)` |

Why a volume on Windows and macOS: a Docker volume is a local Linux filesystem inside Docker's VM, so SQLite's WAL
locking and shared memory work as designed. A Windows or macOS folder is reached through Docker Desktop's file-sharing
layer, which behaves like a network filesystem.

Measured 2026-11-20 on this Windows 11 / Docker Desktop host: 3 claimer containers + 1 API-like writer container on
one SQLite file for 3 s (400 jobs, the `claim-loop.ts` pattern from `reliability.test.ts`):

| `/data` on | Duplicate claims | Jobs succeeded | Writer commits in 3 s | `integrity_check` |
|---|---|---|---|---|
| Docker volume | 0 | 400 / 400 | 20,949 | ok |
| Windows folder (bind mount) | 0 | 400 / 400 | **8** | ok |

The bind mount stayed correct in this run but starved the concurrent writer (about 2,600× fewer commits), so API
requests would time out (`STORAGE_UNAVAILABLE` after the 10 s busy timeout) while the worker is busy. One clean run is
not proof of safe locking on that layer. The active database therefore goes on a Docker volume on Windows and macOS.
macOS bind mounts were not tested.

Never point the Docker stack and a running `pnpm dev` / `pnpm start` stack at the same data at the same time.

Bind-mount examples, for reference only (each needs both lines):

```
# Windows (not validated for SQLite; prefer the volume)
JONATHON_DOCKER_DATA_MOUNT_TYPE=bind
JONATHON_HOST_DATA_DIR=C:\Users\you\JonathonDocker
# macOS (not validated for SQLite; prefer the volume)
JONATHON_DOCKER_DATA_MOUNT_TYPE=bind
JONATHON_HOST_DATA_DIR=/Users/you/Library/Application Support/JonathonDocker
# Linux (native disk; validated pattern)
JONATHON_DOCKER_DATA_MOUNT_TYPE=bind
JONATHON_HOST_DATA_DIR=/home/you/.local/share/jonathon-docker
```

### Missing mounts never start an empty installation

`JONATHON_REQUIRE_EXISTING_DATA=true` (set by Compose) makes the API and the worker refuse to start unless `/data`
holds the `.jonathon-data` marker. `init` writes the marker only:

* when the folder already holds Jonathon data (`projects/` or `jonathon*.sqlite`): it adopts the folder and changes nothing else;
* or when the folder is empty **and** `JONATHON_INIT_NEW_DATA_DIR=true` was given explicitly.

An empty folder without that flag, or a folder with unrelated files, stops `init` with an error, and nothing else starts.

### Permissions

The containers run as `JONATHON_DOCKER_UID:JONATHON_DOCKER_GID` (default `1000:1000`, the image's `node` user). A fresh
Docker volume inherits `/data` ownership from the image (`node`). For a Linux bind mount, make the folder belong to
the uid/gid you set (`sudo chown -R 1000:1000 <dir>` or set the variables to your own `id -u`/`id -g`). `init` checks
read/write access and explains what to fix. Never `chmod 777` the data folder.

### SQLite settings

`node:sqlite` (bundled SQLite with FTS5, no native addon). `journal_mode=WAL`, `synchronous=NORMAL`,
`busy_timeout=10000`, foreign keys on (`packages/core/src/db/index.ts`). Every write path uses `BEGIN IMMEDIATE`
(short, synchronous transactions; nested calls join), so the API and worker serialize writers with bounded waiting, and
a busy database surfaces as a retryable `STORAGE_UNAVAILABLE`. Migrations are forward-only and additive
(`003_queue_hardening` adds one column, one partial index and two tables; no rows are rewritten).

## Moving data in and out

Use the backup and restore tools. Never copy a live `jonathon.sqlite` alone: the WAL file holds committed data, and a
file copy during writes is not a consistent snapshot.

Git Bash on Windows rewrites `/backups/...` into a Windows path; prefix the commands with `MSYS_NO_PATHCONV=1` there.
PowerShell and cmd are not affected.

**Existing native install → Docker volume**

```powershell
# 1. stop pnpm dev / pnpm start, then on the host:
pnpm backup --out D:\JonathonBackups\move-1          # offline, exact, verified
# 2. in docker\compose.env: JONATHON_HOST_BACKUP_DIR=D:\JonathonBackups
docker compose --env-file docker/compose.env --profile tools run --rm restore --from /backups/move-1 --yes
docker compose --env-file docker/compose.env up -d
```

Native data uses `jonathon.sqlite` (live) or `jonathon-demo.sqlite` (demo). Restore writes the file name of the mode the
container runs in (`JONATHON_DOCKER_MODE`), so keep the modes the same.

**Docker volume → host folder (export)**

```powershell
docker compose --env-file docker/compose.env stop server worker web
docker compose --env-file docker/compose.env --profile tools run --rm backup --out /backups/export-1
docker compose --env-file docker/compose.env up -d
```

## Backup and restore

| Kind | Command | Recovery point |
|---|---|---|
| Offline (exact) | stop `server worker web`, then `docker compose … --profile tools run --rm backup --out /backups/<name>` | database and files from the same instant |
| Online | `… run --rm backup --out /backups/<name> --online`, or Operations → **Create backup now** (writes `/data/backups/<stamp>/`) | database snapshot first, then files (files can only be newer) |
| Verify | `… run --rm backup --verify /backups/<name>` | re-hashes every file, runs `PRAGMA integrity_check` |
| Restore | stop `server worker web`, then `… run --rm restore --from /backups/<name> --yes` | the backup's database; files reconciled |

A backup is `jonathon.sqlite` (from `VACUUM INTO`, a transactionally consistent snapshot) plus `projects/` plus
`manifest.json` (SHA-256 of every file, migrations, row counts, integrity result). The offline backup refuses to run
while a worker heartbeat is fresh.

Restore verifies the backup first (any hash mismatch aborts before anything changes), moves the current database and
`projects/` to `/data/pre-restore-<timestamp>/` (never deletes them), copies the backup in, then reconciles: stale
heartbeats are dropped, newer source revisions on disk are re-registered, and knowledge files that differ from the
database are imported as new revisions. A changed file **never keeps an old approval**, because approval events bind
revision + semantic hash. Jobs that were `running` in the snapshot have expired leases and are recovered by the worker.

| Rebuildable from files (projections) | Not rebuildable (only in the database, so only in a backup) |
|---|---|
| FTS5 index and chunks, knowledge projection, source metadata, generated-document index, graph caches | accounts, sessions, MCP token hashes, conversations and messages, jobs and attempts, dead letters, approval events, audit log, idempotency records, runtime session mappings |

Backups are not encrypted. Keep them on encrypted media.

## Job queue

SQLite-backed, no broker (`packages/core/src/jobs/`).

| Concern | Behaviour |
|---|---|
| Claiming | `SELECT` + `UPDATE` inside one `BEGIN IMMEDIATE`, so two workers never claim the same job. Tested with three worker processes plus an API-like writer on one file (`reliability.test.ts`). |
| Leases | `JONATHON_JOB_LEASE_MS` (default 30 s), renewed about every second. Expired leases are recovered on worker start and every 15 s. |
| Stale results | Handlers run inside a lease fence: every transaction they open re-checks, under the write lock, that the job is still `running` under this worker. Knowledge file writes happen inside that transaction, so a worker that lost its lease commits nothing (`LEASE_LOST`). `complete()` and `fail()` from a stale worker change nothing. |
| States | `queued → running → succeeded / partially_succeeded / unsupported / needs_ocr`; `running → retrying → running`; `→ failed` (+ dead letter); `→ cancelled`. **Dead-lettered** is `failed` plus a row in `dead_letters` (documented equivalent; the `jobs.status` CHECK constraint is not rebuilt). |
| Attempts | `JONATHON_JOB_MAX_ATTEMPTS` (default 3) unless a job type sets its own. |
| Backoff | `base · 2^(attempt−1)`, capped, jitter 50–100 % (`JONATHON_JOB_BACKOFF_BASE_MS` 2 s, `…_MAX_MS` 5 min). |
| Transient vs permanent | Transient: `ANTIGRAVITY_UNAVAILABLE`, `ANTIGRAVITY_TIMEOUT`, `INVALID_RUNTIME_OUTPUT`, `STORAGE_UNAVAILABLE` (including disk full `ENOSPC`/`SQLITE_FULL`), `RATE_LIMITED`, `JOB_TIMEOUT`. Everything else is permanent and dead-letters at once. |
| Deadlines | Per type (`DEFAULT_JOB_DEADLINES_MS` in `worker.ts`, 10 min for ingest up to 3 h for folder import), capped by `JONATHON_JOB_DEADLINE_MS`. The deadline aborts the handler and the AI process tree, and the job retries with `JOB_TIMEOUT`. |
| Concurrency and admission | `JONATHON_WORKER_CONCURRENCY` per worker, `AGY_MAX_CONCURRENT` agy processes, `JONATHON_MAX_ACTIVE_JOBS` (default 10 000) active jobs; beyond that, enqueue is `RATE_LIMITED`. |
| Dead letters | `dead_letters`: reason (`attempts_exhausted`, `permanent_error`, `lease_expired`), last error code, sanitized message (paths and tokens removed), full attempt history. `GET /api/v1/ops/dead-letters`. |
| Replay | `POST /api/v1/projects/:pid/jobs/:jid/replay` (and the existing `/retry`): signed-in human only, CSRF-protected, audited as `job.replayed`. Same job row, payload and keys. Repeating it has no extra effect, and if another active job already performs the same operation, that job is returned instead. |
| Business dedupe | `jobs.dedupe_key` with a partial unique index over active jobs: draft extraction (`extract_knowledge:<revision>:<runtime>`), graph mapping (`graph_extract:<revision>`). Ingest, auto-extraction and graph jobs from uploads also keep their permanent `idempotency_key` per revision. A finished job releases its dedupe key, so a deliberate re-run is allowed. |

Failure behaviour:

| Event | What happens |
|---|---|
| Worker crash mid-job | The lease expires and another worker (or the restarted one) recovers the job to `retrying` with backoff. Writes made inside committed transactions stay; nothing half-committed (knowledge writes use intents plus atomic renames, completed by reconciliation). |
| Lost lease while agy still runs | The heartbeat sees `owned=false`, aborts, and the runtime kills the process tree. Any transaction the old handler still attempts fails with `LEASE_LOST`. |
| API restart | Stateless apart from SQLite. In-flight HTTP requests fail, and clients retry (Idempotency-Key makes that safe). |
| Disk full | `STORAGE_UNAVAILABLE` (retryable). Jobs back off and dead-letter after max attempts. Free space, then replay. `ops/health` shows free bytes. |
| Provider timeout | `ANTIGRAVITY_TIMEOUT`, retried with backoff. |
| Repeatedly malformed model output | `INVALID_MODEL_OUTPUT` after the in-job repair attempt is permanent, so it dead-letters at once (no retry storm). |
| Shutdown during a long job | The job is aborted, the subprocess tree killed, and the job released to `queued` without spending an attempt. |

There is no exactly-once execution. Effects are made safe to repeat by idempotency keys, dedupe keys, content-hash
uniqueness, create-only history files and near-duplicate checks in drafting.

## Idempotency keys (REST)

Send `Idempotency-Key: <8–128 chars of A-Z a-z 0-9 _ . : ->` on any signed-in `POST/PUT/PATCH/DELETE` (JSON bodies)
(`apps/server/src/idempotency.ts`).

* The scope is the signed-in user. The fingerprint is SHA-256 of method + path + query + JSON body. A record is held 24 h.
* The first request claims the key atomically (`BEGIN IMMEDIATE` plus the primary key). The response is stored when it finishes.
* The same key and payload replays the stored status and body (`Idempotent-Replayed: true`).
* The same key with a different payload is `422 IDEMPOTENCY_CONFLICT`. Nothing runs.
* A concurrent duplicate while the first is still running gets `429` with `Retry-After: 1`. After 2 min without completion
  (crashed API), the key may be taken over.
* `5xx` outcomes are not stored, so the client may retry. `2xx` and `4xx` are stored.
* Multipart uploads reject the header: identical files are already deduplicated by content hash.
* `ask` and MCP `propose_requirement_change` keep their existing `request_id` idempotency.

## Caching decision

Measured with `pnpm tsx scripts/bench-reads.ts 200` (200 synthetic sources, 3,134 chunks, 2,334 knowledge entities,
in-process, Windows 11 dev machine, 2026-11-20):

| Read | p50 | p95 | Decision |
|---|---|---|---|
| `ops.health` (dashboard polls every 10 s) | 1.65 ms | 1.81 ms | no cache needed |
| project counts (project page) | 0.35 ms | 0.45 ms | no cache needed |
| review queue `knowledge.list` | 132 ms | 272 ms | not polled; caching would risk showing revoked/deleted items, so no cache |
| `graph.overview` warm / cold | 25 ms / 340 ms | 30 ms | **existing** in-process cache, keyed by a fingerprint of `knowledge_revision`, evidence rowids, current revisions, entity `updated_at`, documents and the graph-extraction stamp. Recomputed from SQLite on each call, so it is correct across API and worker processes. |
| `documents.catalogue` | 4.7 ms | 6.3 ms | no cache needed |
| search (FTS5) | 21 ms | 31 ms | no cache (results must reflect deletions immediately) |

No new cache and **no Redis** were added: nothing measured justifies shared or extra caching for one user.
`backup.test.ts` checks that graph projections change after edit, rejection, approval, deletion and source deletion.

## AI runtime

**Status: blocked for containers; demo mode is fully containerized.** Live mode needs the Antigravity CLI.

What was verified:

* Official docs list a Linux installer (`curl -fsSL https://antigravity.google/cli/install.sh | bash`). Architectures
  for the CLI are not documented.
* Sign-in for headless use: "Headless mode uses your cached credentials" from an earlier interactive login, stored in the
  OS keyring (Linux: Secret Service over D-Bus). A container has no keyring or D-Bus session, so account login is not
  expected to work inside the image.
* Documented container-friendly alternatives: `GEMINI_API_KEY` **plus** `"modelProvider": "gemini"` in
  `~/.gemini/antigravity-cli/settings.json`, or `AGY_ADC_AUTH=true` with Google ADC. Jonathon's runtime already passes only
  these variables to agy (`ENV_ALLOW` in `runtime/antigravity.ts`).
* Auto-update behaviour of the CLI is not documented. On the Windows host it auto-updated (1.2.4 → 1.5.9 → 1.5.13), and
  Jonathon's flag checks re-run at startup for that reason.

What was **not** done: downloading and running the vendor install script inside an image (it executes remote code at
build time and needs approval), and any live run in a container. So it is unverified whether the Linux build honours
the flags Jonathon depends on, and whether `--sandbox` works without extra kernel privileges in a `cap_drop: ALL` container.

An empty working directory and tool denial are not filesystem isolation by themselves. In the current containers, the
worker process that would spawn agy has `/data` mounted read-write, so a containerized agy would sit inside the trust
boundary of all client files. Before live mode is containerized, the proposed design is:

1. A separate `runner` container with **no** `/data`, `/imports` or backups mount, its own `agy` install and credentials
   (an API key or ADC from a Docker secret, never copied from the host profile), and egress only to the provider.
2. A minimal authenticated interface: the worker sends `{schema, prompt, model, effort}` (the evidence is already inside
   the prompt) over the internal network with a shared secret. The runner runs the existing `AntigravityCliRuntime`
   unchanged and returns the normalized result with the same size limits and timeouts.
3. No Docker socket in any container.

This is a proposal only. It needs a verified Linux `agy` and credentials first.

**Hybrid option (not fully containerized):** for live AI today, run Jonathon natively (`pnpm start`) with agy on the host,
as before. Do not split one data directory between a native process and containers on Windows or macOS (see Storage).

## Image and version inventory

Verified on 2026-11-20 (IST) with `docker buildx imagetools inspect` and local builds:

| Item | Version / digest | License | Notes |
|---|---|---|---|
| Base image | `node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0` (Docker Official Image, Debian 13) | Node.js: MIT; Debian packages: various OSS (see the image's `/usr/share/doc/*/copyright`) | Multi-arch index: linux/amd64, linux/arm64/v8, ppc64le, s390x. **Built and tested: linux/amd64 only.** arm64 is expected to work (no native addons) but was not tested. |
| Node.js | 24.22.3 in images (host dev: 24.20.0) | MIT | `engines.node >= 24` (`node:sqlite`) |
| pnpm | 12.16.1 via corepack (`packageManager`) | MIT | `pnpm install --frozen-lockfile` |
| SQLite | bundled in Node (`node:sqlite`), FTS5 checked by `init` | public domain | no native addon, no apt packages |
| Next.js | 16.4.5 (standalone output) | MIT | |
| Fastify | 5.12.8 | MIT | |
| tsx | 4.23.15 (server runtime loader) | MIT | |
| Built images | `jonathon-server:local` 479 MB, `jonathon-web:local` 392 MB (uncompressed, local build 2026-11-20) | | not published to a registry |
| Redis | not used | | |

To update the base image: run `docker buildx imagetools inspect node:<version>-trixie-slim`, replace the tag and
digest in the `Dockerfile` `ARG NODE_IMAGE`, rebuild, run `pnpm test` and `scripts/docker-smoke.ts`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `init` exits: "data directory /data is empty" | Wrong or missing mount. For a NEW install, set `JONATHON_INIT_NEW_DATA_DIR=true` once. |
| server/worker exit: "no .jonathon-data marker" | `init` did not run against this mount. Run `docker compose … up` (not `up server`). |
| `ports are not available` | 3005 or 4100 is taken (often a running `pnpm dev`). Stop it or change `JONATHON_DOCKER_UI_PORT` / `JONATHON_DOCKER_MCP_PORT`. |
| `FORBIDDEN: invalid Host header` | You reached the API by a name not in the allowlist. Use `127.0.0.1` or `localhost`. |
| Worker "not running" in the UI | `docker compose … ps worker`, `docker compose … logs worker`. |
| Uploads stay queued | Worker unhealthy or stopped, as above. |
| `STORAGE_UNAVAILABLE` | Disk full or the database is busy. Check `docker system df` and free space, then replay dead letters. |
