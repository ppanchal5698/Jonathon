# Connecting Claude Code to Jonathon (MCP)

Jonathon exposes an MCP server over **Streamable HTTP** at `http://127.0.0.1:4100/mcp`. It is stateless and needs a bearer token.
It was verified with the official MCP TypeScript client SDK 2.4.0 (`apps/server/test/server.test.ts`). Claude Code's
`claude mcp add` syntax is taken from <https://code.claude.com/docs/en/mcp>.

## 1. Create a credential

In the UI, open **MCP access**, select the project(s), and leave "Allow proposing" off unless you want Claude Code to file
change proposals. Choose an expiry and select **Create credential**. The token (`jon_…`) is shown **once**, and Jonathon stores only its hash.

## 2. Register the server

Put the token in your environment, not in the repository:

```powershell
$env:JONATHON_MCP_TOKEN = "jon_..."     # PowerShell; add to your profile to persist
```

```bash
claude mcp add --transport http --scope user jonathon http://127.0.0.1:4100/mcp --header "Authorization: Bearer ${JONATHON_MCP_TOKEN}"
```

`--scope user` keeps the configuration out of the client repository. If you use `--scope project`, the generated `.mcp.json`
contains the header template with `${JONATHON_MCP_TOKEN}`, which Claude Code expands from the environment. Never commit a literal token.

Check it with `claude mcp list`, or with `/mcp` inside Claude Code.

## 3. Tools

| Tool | Scope | Purpose |
|---|---|---|
| `list_projects` | read | Projects this token can access |
| `ask_jonathon` | read | Question with citations. Pass `conversation_id` for follow-ups, `feature_scope` for readiness, `request_id` for idempotency |
| `search_knowledge` | read | Search evidence and knowledge |
| `get_requirement` | read | One entity (REQ-, DEC-, QUESTION-, CONFLICT-, CHANGE-). `approval_valid` tells you whether it is approved |
| `get_feature_spec` | read | Approved requirements and decisions for a feature, with server-computed `implementation_ready` and reasons |
| `get_job` | read | Poll a pending job and get the answer when done |
| `propose_requirement_change` | propose | File a proposal against the requirement's **current** revision. It is never applied automatically |

There is deliberately no approval tool, no general write tool and no shell tool.

### Pending results (Jonathon's contract, not an MCP feature)

`ask_jonathon` waits up to `JONATHON_ASK_WAIT_MS` (default 25 s). If the answer is not ready, it returns:

```json
{ "status": "pending", "job_id": "job_…", "conversation_id": "conv_…", "project_id": "prj_…", "message": "Still working (…). Poll get_job with this job_id." }
```

Call `get_job` with the same `project_id` and `job_id` until `answer` is present (or the job reports `failed` with an error code).
Re-sending `ask_jonathon` with the same `request_id` returns the same turn, never a duplicate.

### Errors

Tool errors come back as `isError: true` with `{ "error": { "code", "message", "correlation_id" } }`, using the codes in
`packages/contracts/src/errors.ts` (for example `PROJECT_NOT_FOUND`, `FORBIDDEN`, `REVISION_CONFLICT`, `ANTIGRAVITY_AUTH_REQUIRED`).

## 4. Revoking and rotating

On the **MCP access** page, choose **Revoke** (the token stops working immediately) or **Rotate** (a new token is issued and the old one is revoked).
**Access log** shows each tool call with its outcome and error code, but not arguments or answers.

## 5. Repository instructions

Copy [`sample-CLAUDE.md`](sample-CLAUDE.md) into the client repository as `CLAUDE.md`, and fill in the project ID.
