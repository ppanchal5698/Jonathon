# Jonathon

A local-first client knowledge and requirements platform. Jonathon preserves client material, extracts it with
locators, answers questions with traceable citations, keeps human-approved requirements apart from drafts, and serves
that knowledge to Claude Code over MCP. Antigravity CLI (`agy`) does the reasoning **without tools**. Jonathon owns the
storage, permissions, conversations and approvals.

* No Obsidian, Notion or other knowledge app is required. Knowledge is stored as plain Markdown that any editor, Obsidian included, can open.
* Single user, loopback only, with an authenticated UI and token-authenticated MCP.
* AI processing is a **per-project choice** made when you create the project (the form's consent box is ticked by default; the API default
  stays off). When it is on, every uploaded document is drafted into proposed requirements, descriptions, open questions, conflicts and
  change proposals that you approve, edit, reject or delete in the project's **Review** tab. The relevant client text goes to the
  Antigravity CLI and on to its model provider. Jonathon orchestrates locally; it does not run a model locally.
* **Tech docs**: 66 pre-development technical documents in 10 categories (SRS, user stories, NFRs, RBAC, HLD, C4, ADRs, API
  contract, data model, threat model, CI/CD, test strategy ...) generated from the project's material and knowledge. Every
  item is labelled client-stated, from client material, knowledge, AI proposal or gap. Documents update themselves when
  material is added or removed, never overwrite a section you edited, and are approved per revision.
* **Memory graph**: every document, passage, requirement, question, conflict, concept and generated document of a project
  in one graph, also written as graphify-compatible `graph/graph.json` for the graphify CLI.

## Requirements

| | Version used | Notes |
|---|---|---|
| Windows 11 / macOS / Linux | Windows 11 verified | |
| Node.js | 24.x (24.20.0 verified) | uses built-in `node:sqlite` with FTS5, so no native build tools |
| pnpm | 12.16.1 | `corepack enable` |
| Antigravity CLI `agy` | 1.5.9 verified | sign in once by running `agy` interactively |

## Setup

```bash
pnpm install
```

```bash
pnpm run doctor
```

```bash
pnpm dev
```

Open <http://127.0.0.1:3000>, create the local account, and read the data-sharing notice. Create a project (leave "Draft
requirements from uploaded documents with AI" ticked if you want automatic drafts), upload documents, then work through **Review**.

Optional fictional demo project (after the account exists):

```bash
pnpm seed:demo
```

Configuration lives in `.env` (copy `.env.example`). By default the data folder is `%LOCALAPPDATA%\Jonathon`, and it must be outside the repository.
To try the UI without any AI runtime, set `JONATHON_MODE=demo`. The banner then says so, and answers are extractive quotes labelled `demo-extractive`.

Connect Claude Code: [docs/claude-code.md](docs/claude-code.md). Sample repository instructions: [docs/sample-CLAUDE.md](docs/sample-CLAUDE.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | API + worker + UI in watch mode |
| `pnpm build` / `pnpm start` | typecheck + production Next.js build / run all three |
| `pnpm test` | unit + fixture-based integration tests (no network) |
| `pnpm test:e2e` | Playwright browser test against real API, worker and UI (fixture CLI) |
| `pnpm test:live` | **live** tests against the real `agy`; they send fictional text to the model provider |
| `pnpm lint` / `pnpm typecheck` | Biome / tsc for every package |
| `pnpm run doctor` | read-only environment checks (`pnpm doctor` without `run` is pnpm's own built-in command); `pnpm run doctor --provider` also checks agy sign-in |
| `pnpm seed:demo` | add the fictional demo project |
| `pnpm db:migrate` | apply SQLite migrations (also done on server start) |
| `pnpm tsx scripts/runtime-probe.ts [answer\|extraction]` | print one live agy run's event sequence (diagnostics) |

## Documentation

* [Architecture](docs/architecture.md) and ADRs ([0001](docs/adr/0001-architecture.md), [0002](docs/adr/0002-owned-storage-and-runtime-isolation.md))
* [Compatibility record](docs/compatibility.md): what was verified on this machine, and how
* [Threat model](docs/threat-model.md)
* [Operations: backup, restore, troubleshooting](docs/operations.md)
* [Supported formats](docs/formats.md)
* [Implementation status and journal](docs/implementation-status.md), including known limitations
