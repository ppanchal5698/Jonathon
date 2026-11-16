# Requirements: Jonathon

Use Jonathon as the requirements service for this repository.

- Jonathon MCP server: `jonathon`. Project ID: `prj_REPLACE_ME` (confirm with `list_projects` before querying).
- Confirm the project ID before querying.
- Fetch approved requirements and decisions before implementing a feature (`get_feature_spec`, `get_requirement`).
- Ask follow-up questions when requirements are incomplete (`ask_jonathon`, reuse `conversation_id` for follow-ups).
- Treat drafts and AI suggestions as unapproved. Only items with `approval_valid: true` are approved.
- Do not invent missing business rules.
- If a business decision blocks implementation, report it to Parth.
- Reference requirement IDs and the knowledge revision in your implementation summary.
- Propose requirement changes through Jonathon (`propose_requirement_change`). Do not alter approved knowledge directly.
- Report implementation observations separately from client requirements.

## Notes for the agent

- `implementation_ready` is computed by Jonathon for a named feature. If it is `false`, read `readiness_reasons` and stop at the blocker.
- If `ask_jonathon` returns `status: "pending"`, poll `get_job` with the returned `job_id`.
- A citation's `support_check: "quote_verified"` proves where text came from, not that it supports the claim. Read the excerpt.
