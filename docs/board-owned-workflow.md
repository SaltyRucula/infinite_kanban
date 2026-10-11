# Running the board-owned A2A workflow

This is additive. Legacy worker poll/claim and local agent execution remain separate.
The new path is `POST /api/tasks/:id/workflow/run`, not the legacy `/run` route.
OpenCode and Codex are endpoint configuration choices, never task requirements.

## Build and repeat the real demo

Use Node 22 (native SQLite in this checkout is built for it):

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
export TMPDIR="$HOME/.hermes/cache/scratch"
unset NODE_ENV
npm run build:server
npm run worker:build
# Actual OpenCode implementation and independent endpoint review:
DEMO_REVIEW_HARNESS=opencode node scripts/demo-board-a2a.mjs
# Mixed harnesses (Codex must be authenticated through its own CLI):
node scripts/demo-board-a2a.mjs
# Swap the same implementation role without changing task/policy/schema:
DEMO_IMPLEMENTATION_HARNESS=codex DEMO_REVIEW_HARNESS=opencode node scripts/demo-board-a2a.mjs
```

The demo creates a real small Git fixture, fresh SQLite DB, built board process,
two loopback native A2A endpoints on free ports, and isolated endpoint workspaces.
It holds the fixture, requirements, schema and board policy fixed, varying only
endpoint harness configuration. It registers Agent Cards, grants project roles,
starts the board workflow, waits for pinned review, grants explicit human approval,
and reads back the workflow and task. It exits nonzero on failure, without synthetic
fallback. Logs, endpoint state, source fixture, evidence artifacts and `report.json`
remain in a printed scratch directory. Its portable repository identity is an
explicit local fixture mapping, not a claim that a demo repository exists on GitHub.
The preexisting `demo-two-agents.mjs` is still a legacy demo, not A2A proof.

`DEMO_OPENCODE_MODEL` and `DEMO_CODEX_MODEL` select endpoint-local models.
The verified OpenCode deployment uses `github-copilot/gpt-6.1-sol`; this is a
local demo default, not a board routing requirement. Model listing is not proof
of usable authorization. No CLI auth files are read by the demo or board.

## Native endpoints and admission

An endpoint can be implemented externally without this worker. Advertise A2A
1.0 JSON-RPC `SendMessage`, `GetTask`, `CancelTask`, and card skill tags:

- `execution:v1`
- `repository:<canonical host/path>` (existing repository normalization)
- `consent:<projectId>` (endpoint consent, separate from board project-role grant)
- required capabilities, and `review:snapshot` for read-only review

Grant roles using `PUT /api/a2a-agents/:id/projects/:projectId/roles`.
The board selects by role, repository, capability and consent, and rejects the
same endpoint identity or URL as its independent reviewer. Registration needs
board authorization; endpoints receive no general board mutation credential.
Directory/outbound URLs reuse existing HTTPS/private-network HTTP policy.
The provided endpoint listener binds only loopback. Do not expose it publicly
without an authenticated private deployment boundary.

`shared/execution.ts` defines strict schemaVersion 1. `projectId` was added to
the proposed assignment fields so endpoints can enforce consent independently.
Assignments travel in native structured A2A data parts. Exactly one result data
part is required in completion artifacts. Correlation is board-issued task/run/
assignment/attempt/endpoint identity; the board binds endpoint identity to its
own dispatch record. Text and `REVIEW_VERDICT` do not settle the workflow.

`startExecutionEndpoint(config)` in the built worker package exposes the new
native listener. Config owns `harness`, optional `model`, `roles`, `projects`,
`repositories` (portable identity → local checkout), `stateDirectory`,
`capabilities`, and trusted `checks` ({name, command, args}). See the real demo
for an executable configuration example. Board paths and credentials never
enter assignments. Legacy worker `a2a-server.ts` remains the legacy assignment
listener; its completion is not used to settle this new execution contract.

Implementation clones a separate checkout at the exact base commit, lets the
harness implement, commits the result, and publishes objects into its configured
source repository without editing that source working tree. Review clones that
source at the exact accepted commit, not HEAD. Different-machine deployments
must make the commit available in the review endpoint's mapped source (e.g. a
trusted Git publication/fetch mechanism); the provided local adapter does not
silently push to a remote or fall back to a branch. An inaccessible commit fails.

OpenCode review requires v2's enforced edit AND shell denies; v1 review is refused.
Codex uses its SDK's read-only sandbox, no network, no approval escalation.
This is not a claim that arbitrary repository tests are safe: endpoint-configured
check commands execute trusted code in the isolated checkout. Deployment operators
must control those checks. Review verifies its worktree/HEAD did not change during
the harness turn. Unsupported constraint fields (billing limits, arbitrary hard
restrictions) are rejected before harness execution, rather than advertised as
prompt-only guarantees.

Evidence is stored content-addressed. `urn:sha256:<digest>` resolves through
`GET <endpoint-origin>/artifacts/<digest>`; the board downloads and verifies it.
HTTPS artifact references are also allowed under existing URL policy. Missing,
wrong-subject, unresolvable or digest-mismatched evidence prevents acceptance.
`policy.requiredChecks` declares checks which must have passed.

## Board controls and persistence

- `GET /api/tasks/:id/workflow`: durable history, IDs, evidence, decisions and diagnostics.
- `POST .../workflow/run`: `{repository, baseRevision, requiredCapabilities?, policy?}`.
- `POST .../workflow/approve`: `{revision}`. Exact approved revision, principal and time are recorded.
- `POST .../workflow/cancel`: `{}`. Fences locally before remote cancellation.
- `POST .../workflow/retry`: `{}`. Explicit retry of canceled/escalated attempts, preserving history and limits.

Default policy requires human approval; optional `autoFinish:true` is an explicit
board policy. Defaults: three review rounds, six dispatches, one-hour deadline.
Changes requested return actionable findings to a new implementation assignment.
Accepted implementation changes invalidate prior approval; exhausted limits
escalate visibly. Legacy task writes/run/assignment cannot bypass owned workflows.
The browser task details expose harness-free start, state, revision, assignment
history, evidence/check outcomes, approval and cancel controls. Retry is currently
API-only.

SQLite and PostgreSQL use the same `board_workflow_runs` versioned JSON document
schema and compare-and-swap updates. Send intent is persisted before transport;
new dispatches use no transport retries. Restart reconciliation polls existing
remote IDs. The provided endpoint uses assignmentId as task ID and persists
messageId duplicates, so ambiguous sends can be reconciled without repeating work.
For an external endpoint which loses the receipt and cannot resolve that correlation,
the run remains uncertain instead of blindly redispatching. Explicit cancel/retry
is an operator decision, not a guarantee that an unreachable executor has stopped.
Late/fenced responses are diagnostic history only. Workflow projection back to the
board is replayable after restart. This slice supports standalone tasks; task groups
are explicitly refused instead of claiming unimplemented group integration.

## Verified delivery and blockers (October 10, 2026)

- Genuine OpenCode→OpenCode native A2A run completed with pinned review, passing
  endpoint-run `node:test` evidence, human approval and task Done. The reviewer
  explicitly reported static inspection only; the test execution was performed
  separately by the endpoint, not attributed to its read-only harness.
- Report: `/Users/CTW01561/.hermes/cache/scratch/board-a2a-demo-2rvIPF/report.json`.
- Workflow `1bfa12ce-df2d-4702-b1c6-f3cf3fb7044f`;
  implementation `5d32146d-3c58-4dd8-8a61-d08d30c7a57c` (attempt 1);
  review `afaf1e4d-f2fd-4f1b-b566-8d2121888a77` (attempt 2).
- Accepted and reviewed commit: `0d575b24c5670716db2279cd6cd02c0d305ea98d`.
- Mixed OpenCode→Codex was actually attempted. Codex CLI 0.139.0 reports
  **Not logged in** and its real review execution failed with **401 Unauthorized**.
  Report: `/Users/CTW01561/.hermes/cache/scratch/board-a2a-demo-UeZPrS/report.json`.
  No two-harness or successful Codex role-swap claim is made.
- Subsequent OpenCode repeats were not consistently successful: the latest built
  replay admitted implementation and verified its artifacts, then review returned
  `Unauthorized` from the model provider. Latest failure report:
  `/Users/CTW01561/.hermes/cache/scratch/board-a2a-demo-ucroDC/report.json`.
  This is a live authorization/reliability blocker, not a successful replay claim;
  the successful genuine OpenCode report above remains preserved.
- PostgreSQL query/schema parity is exercised with pg-mem, not a running PostgreSQL
  server. SQLite and browser tests use real databases/processes.
- Full accepted-spec gates remain open until authenticated second-harness execution
  (including same-role swap) and production PostgreSQL verification can be completed.
