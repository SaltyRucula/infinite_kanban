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
Pass a board URL to drive a board you are already watching
(`node scripts/demo-board-a2a.mjs http://127.0.0.1:8080`); with no argument the
demo starts and tears down its own private board. The legacy poll/claim demo
has been removed: it settled reviews by parsing a `REVIEW_VERDICT` marker out
of narrative text, which this contract rejects.

`DEMO_OPENCODE_MODEL` and `DEMO_CODEX_MODEL` select endpoint-local models.
The verified OpenCode deployment uses `github-copilot/gpt-6.1-sol`; this is a
local demo default, not a board routing requirement. Model listing is not proof
of usable authorization. No CLI auth files are read by the demo or board.

## Connecting an execution endpoint

One command per endpoint. It starts the endpoint, registers its Agent Card with
the board and asks for the role, then waits for the board to dial it:

```sh
agentboard-worker execute \
  --role implementation \
  --project <projectId> \
  --repo https://github.com/you/repo=/local/checkout \
  --harness opencode \
  --check "tests=npm test" \
  --board http://127.0.0.1:8080
```

| Flag | Meaning |
|---|---|
| `--role` | `implementation` or `review` — the only thing the board routes on |
| `--project` | Projects this endpoint consents to serve (comma separated) |
| `--repo` | `portable-identity=/local/path`; comma-separate several. The identity is what travels on the wire; the path is only where this machine keeps that repository |
| `--harness` | which brain this endpoint runs, endpoint-local (default `opencode`) |
| `--model` | Endpoint-local model, never a task property |
| `--check` | `name=command args`, run in the isolated checkout to produce evidence |
| `--capability` | Advertised capabilities (default `git:revision`) |
| `--board` / `--api-key` | Board URL and bearer token when the board requires one |
| `--port` / `--state-dir` | Fixed listen port and identity/artifact directory |

`--role` takes both: `--role implementation,review`. An endpoint is not an
implementer or a reviewer by nature, it is whatever roles it accepts, and the
board keeps the two apart **per task by identity** — it refuses to let the
endpoint that produced a revision review it. So a fleet of identical dual-role
endpoints is the normal deployment: each one implements some tasks and reviews
others.

You still need at least two endpoints. A single dual-role endpoint implements a
task and then escalates with `no eligible distinct review endpoint`, rather
than reviewing its own work. Each endpoint needs its own `--state-dir`.
Registration failures are fatal on purpose: an endpoint that is running but
unknown to the board looks healthy while silently receiving no work.

The harness never appears in the task. Swapping `--harness` on the review
endpoint changes who reviews, with no change to the task, the policy or the
board.

## What a run looks like while it is running

The coordinator records every decision it makes on the task's own event log,
and relays the endpoint's progress into the same stream, so the panel shows:

```
[tool_call]      Assigned implementation attempt 1 to Execution endpoint (opencode)
[tool_call]      Reading add.cjs
[command]        node --test add.test.cjs
[command_output] ok 1 - adds
[output]         Accepted implementation of 0906f7e0 (implementation: passed, node-tests: passed)
[tool_call]      Assigned review attempt 2 to Execution endpoint (opencode)
[test_result]    Accepted review of 0906f7e0 — verdict approved (snapshot-review: passed)
[complete]       Approved 0906f7e0 by open-deployment
```

Failures are recorded the same way. Before this, an escalated run reached the
board as a `failed` task with **no events at all**, and the panel could only
say *"This run did not record an error event."* — the board admitting it had
thrown the reason away. Now the reason is the event:

```
[error] Workflow escalated during dispatch: no eligible implementation endpoint
        with repository access and consent
```

Progress is relayed exactly once per message. The relayed ids are persisted
with the dispatch, so restarting the server resumes the stream instead of
replaying the backlog into the panel.

The event sink is advisory: if recording fails, the workflow continues. Losing
a line of narration must never cost a run.

## Which brains an endpoint can run

`--harness` resolves against a registry rather than a hardcoded pair:

| Harness | Implementation | Review | Why |
|---|---|---|---|
| `opencode` | yes | yes | v2 enforces edit **and** shell denies (v1 is refused) |
| `codex` | yes | yes | SDK read-only sandbox |
| `hermes` | yes | yes | ACP asks permission per tool call |
| `openclaw`, `grok` | yes | yes | same ACP permission flow |
| `copilot` | yes | **no** | it inspects files through the shell, which a read-only review must deny |
| `claude` | yes | **no** | the provider ignores permission hooks, so edits cannot be prevented |

`review` is **refused at connection time** for a harness that cannot enforce
read-only, with the reason printed. That is the contract rule — an endpoint must
refuse what it cannot enforce — applied to the brain, not just the assignment.
A prompt asking a model not to edit is not an enforcement mechanism.

These are observations, not guesses: the Copilot entry was downgraded after a
real review run ended with nothing but its opening narration, because every
file read it attempted went through the denied shell.

Harnesses also differ in output discipline. The endpoint requires a structured
document, but tolerates narration or a ``` fence around it, and keeps the raw
text next to the assignment id when it cannot find one.

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
