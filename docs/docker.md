# Running Jonathon with Docker Compose

Single host, single user. **Not highly available**: one SQLite file, one API, one worker on one machine. Demo mode needs
no AI. Live mode runs the Antigravity CLI (`agy`) inside the worker, signed in with Google from the Setup page; see
[AI runtime](#ai-runtime).
The non-Docker workflow (`pnpm dev`, `pnpm start`) is unchanged and is still the way to develop with hot reload.

## Quick start (clean checkout, demo mode)

```powershell
copy docker\compose.env.example docker\compose.env
# First start of a NEW installation only: set JONATHON_INIT_NEW_DATA_DIR=true in docker\compose.env
docker compose --env-file docker/compose.env up -d --build
docker compose --env-file docker/compose.env ps
```

Open <http://localhost:3005>, create the local account (or sign in with Google when it is configured; see
[Sign in with Google](#sign-in-with-google-jonathon-account)), then set `JONATHON_INIT_NEW_DATA_DIR=false` again.
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
| `worker` | `jonathon-worker:local` (`worker`: server + `agy`) | `src/worker.ts` | none | `/data`, `/imports:ro`, `/home/agy` (`jonathon-agy-home`) | default bridge (outbound to the model provider) |
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

## Sign in with Google (Jonathon account)

With `JONATHON_GOOGLE_CLIENT_ID` and `JONATHON_GOOGLE_CLIENT_SECRET` set, **Google is the only way to sign in**: the
setup screen and the login page show only "Sign in with Google", and `POST /api/v1/setup/account` and
`POST /api/v1/auth/login` are refused. Without them, the username/password account works as before.

One-time setup in Google Cloud Console (needs your Google account; Jonathon cannot do it):

1. APIs & Services → **OAuth consent screen**: user type External, publishing status Testing, add your Google
   account under Test users. Scopes: `openid`, `email`.
2. APIs & Services → **Credentials** → Create credentials → **OAuth client ID** → type **Web application**.
   Authorized redirect URI: `http://localhost:3005/api/v1/auth/google/callback` (use your UI port if you changed it).
   Alternatively register `http://localhost:<UI port>/oauth2callback` and set `JONATHON_GOOGLE_REDIRECT_PATH=/oauth2callback`;
   the UI forwards that path to the same handler. Example in use: UI port 6969 (`JONATHON_DOCKER_UI_PORT=6969`),
   JavaScript origin `http://localhost:6969`, redirect URI `http://localhost:6969/oauth2callback`.
3. Put the client ID and secret into `docker/compose.env` (git-ignored) as `JONATHON_GOOGLE_CLIENT_ID` /
   `JONATHON_GOOGLE_CLIENT_SECRET`. Recommended: `JONATHON_GOOGLE_ALLOWED_EMAILS=<your address>`.
4. `docker compose --env-file docker/compose.env up -d` and open `http://localhost:3005` (use `localhost`, not
   `127.0.0.1`: the redirect URI must match exactly).

How it works (`packages/core/src/security/google-signin.ts`, `apps/server/src/server.ts`):

* Authorization code flow with PKCE (S256), `state` and `nonce`, scopes `openid email`. The state, nonce and PKCE
  verifier live server-side for 10 minutes and are single-use. A random binder in an HttpOnly, `SameSite=Lax` cookie
  (path `/api/v1/auth/google`) ties the return to the browser that started it.
* The API exchanges the code with the client secret over the back channel (the API container needs outbound HTTPS to
  `oauth2.googleapis.com`). It checks the ID token's issuer, audience/azp, expiry, nonce and `email_verified`. It keeps
  only the Google account ID (`sub`) and email; Google's access token is discarded.
* **Owner binding:** the first Google account to sign in to an install without an account becomes its owner. After
  that only that Google account can sign in; any other gets "this Jonathon belongs to another Google account".
  `JONATHON_GOOGLE_ALLOWED_EMAILS` also restricts the first sign-in. An install created earlier with a password links
  to Google only for an email on that list.
* Sessions, CSRF and Origin/Host checks are unchanged. The callback is the only route that accepts a cross-site
  request (Google redirects the browser there); it is GET-only and protected by state + PKCE + binder. It answers with
  a small same-origin page that moves on to the app, because a redirect chain that began at Google would make the
  browser withhold the `SameSite=Strict` session cookie on the next page.
* Lost the owner Google account: set `JONATHON_GOOGLE_ALLOWED_EMAILS` to the new account, restart, then run
  `docker compose --env-file docker/compose.env exec server node --import tsx src/cli/release-google-owner.ts --yes`.
  Data is kept; all sessions end.

This is separate from the Antigravity CLI's own Google sign-in in the worker (next section). The two use different
OAuth clients, so one sign-in cannot authorize both.

## AI runtime

**Live mode runs in Docker.** The worker image (`jonathon-worker:local`, Dockerfile target `worker`) contains the
Antigravity CLI. The API and UI images do not.

### What is installed, and how

* `agy` **1.5.13**, Linux build for amd64 or arm64, picked by `TARGETARCH`. It is pinned by download URL and SHA-512 from
  the vendor's release manifest, the same check the official `install.sh` makes. The install script itself is not run.
  The binary is root-owned in a read-only filesystem, so it cannot self-update. To upgrade, change `AGY_VERSION`,
  `AGY_URL_*` and `AGY_SHA512_*` in the Dockerfile (read the new values from
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json` and `linux_arm64.json`),
  rebuild, and run `pnpm test:live` against it.
* `ca-certificates`: `agy` is a Go binary and needs the system CA bundle (Node.js ships its own). Without it the token
  exchange fails with `x509: certificate signed by unknown authority`.
* `script` from util-linux, already in the base image: gives the sign-in run a terminal (see below).

### Sign in with Google (Setup page)

Set `JONATHON_DOCKER_MODE=live` in `docker/compose.env`. Live mode uses its own database file (`jonathon.sqlite`), so
create the local account once more. Then open **Setup & runtime → Antigravity sign-in → Sign in with Google**:

1. The worker starts `agy` in an empty workspace with Jonathon's tool-free agent and deny settings.
2. `agy` prints Google's OAuth link (PKCE). Jonathon shows it only if it is `https://accounts.google.com/o/oauth2/…`
   with a client id and a code challenge.
3. You open it, sign in **on Google's page in your own browser**, and copy the authorization code that
   `antigravity.google/oauth-callback` shows.
4. You paste the code into Jonathon within about 55 s (`agy` waits 60 s). The worker types it into `agy`'s terminal.
   The code is stored in SQLite only until the worker reads it, a fraction of a second, and is useless without the PKCE
   verifier held by that `agy` process.
5. `agy` exchanges the code. Jonathon stops the process before any prompt runs, then confirms the sign-in with
   `agy models`.

Jonathon never sees your Google password. Audit events record `runtime.sign_in_requested`, `runtime.signed_in`,
`runtime.sign_in_failed`, `runtime.sign_out_requested` and `runtime.signed_out` with the person, never the link or code.

Verified facts this relies on (agy 1.5.13, linux/amd64, `cap_drop: ALL`, read-only root filesystem, uid 1000):

| Observation | Consequence |
|---|---|
| With stdin from `/dev/null` or a terminal, an unauthenticated `-p` run prints the link and reads the code. With stdin as a pipe it refuses ("Run 'antigravity' to log in"). | The sign-in run is wrapped in `script -qfec` (a pseudo-terminal). The command line holds only fixed, single-quoted arguments; the code is typed into the terminal. |
| Log: "Using file-based token storage because no D-Bus session bus detected". | No keyring daemon is needed. Tokens live in files under `$HOME`. |
| A wrong code gives `invalid_grant`. | Shown as "Google rejected the code … Start again." |

`$HOME` for the worker is `/home/agy`, the Docker volume **`jonathon-agy-home`**. It is mounted only into the worker,
not into the API, UI, backup or restore containers, and it is not part of the client-data volume or of backups.

### Sign out

**Setup & runtime → Antigravity sign-in → Sign out.** The worker deletes `agy`'s stored credentials and account files
inside `/home/agy` (never outside it), then runs `agy models`. It reports success only when `agy` says it is not signed
in. If `agy` still reports a sign-in, it removes everything `agy` keeps under that home, including its local
conversation transcripts, and checks again. Removing the volume (`docker volume rm jonathon-agy-home` while the stack is
down) also signs out.

Signing out removes the credentials from this computer. To revoke the Antigravity CLI's access entirely, also remove it
under Google Account → Security → "Third-party apps with account access".

Sign-in and sign-out are available only where Jonathon owns `agy`'s home (`JONATHON_AGY_HOME`, honoured only inside a
container). A native install never offers them, so Jonathon cannot sign your own desktop `agy` out. There, sign in by
running `agy` in a terminal, as before.

### Isolation: what this does and does not give

* Each run starts in an empty per-project workspace, with the tool-free agent, the session deny settings, `--sandbox`,
  a scrubbed environment, output limits and process-tree kill, exactly as on the host. Evidence goes in the prompt.
* **Trade-off (chosen):** `agy` runs **inside the worker container**, which mounts `/data` read-write. The tool-free
  agent and deny rules are what keep the model from touching client files; the container boundary does not. A stricter
  setup, a separate `runner` container with no data mounts that receives only the prompt, is not built. See
  [threat-model.md](threat-model.md).
* The worker needs outbound internet for the model provider. No Docker socket is mounted anywhere.

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
| Antigravity CLI | 1.5.13 (linux amd64/arm64), pinned URL + SHA-512 | Google terms of service (proprietary) | worker image only |
| ca-certificates | Debian trixie package (apt, at build time) | MPL-2.0 / various | worker image only |
| Built images | `jonathon-server:local`, `jonathon-worker:local`, `jonathon-web:local` (sizes in deployment-audit.md) | | not published to a registry |
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
