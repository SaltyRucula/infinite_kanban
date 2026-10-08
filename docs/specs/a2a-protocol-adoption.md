# A2A Protocol Adoption

Status: **accepted — phase 1 in progress** (decisions in §9)
Protocol target: **A2A v1.0** (`https://a2a-protocol.org/latest/specification/`)
SDK: **`@a2a-js/sdk@1.3.0`** (`./server`, `./server/express`, `./client`; `express ^4.21.2` peer matches server's `express ^4.22.2`)

## 0. Relationship to `docs/proposals/a2a-first-rework.md`

That proposal is the **product** decision: the board becomes a workflow coordinator, A2A agents are the execution endpoints, and the legacy worker fabric is retired (waves 0–4). Waves 0–2 are merged (#70–#73): trusted agent directory, JSON-RPC executor, default-off workflow gate, console UI.

This document is the **protocol** companion to it, and covers what the proposal left open:

- the exact board ⇄ A2A data mapping (states, events, assignments, cards) — §4;
- the board as an A2A **server**, so other agents and orchestrators can send work *to* it; the merged work only makes the board a client — §4.3, §4.5;
- wire-level conformance to v1.0, including the version mismatch found in the merged executor (see below) — §9.1;
- the transport consequence of retiring pull workers — §5.

**Conformance defect found in the merged executor** (now filed): `a2a-workflow-client.ts` sends v0.3 method names (`message/send`, `tasks/get`, `tasks/cancel`) and v0.3 tagged parts (`{kind:'text'}`) with no `A2A-Version` header, while `a2a-agent-card.ts` only accepts v1.0 Agent Cards (`supportedInterfaces[].protocolVersion`). A v1.0 agent would reject those calls, and an absent version header means the peer assumes 0.3 (spec §3.6.1).


## 1. Goal

Make agent-to-agent communication in this repo speak A2A instead of bespoke HTTP, so that:

- an external agent (Hermes, an orchestrator, another board) can **send work to this board** over A2A;
- the board can **send work to remote agents** over A2A (workers become A2A agents, and any third-party A2A agent becomes usable as an executor);
- task state, streaming progress, clarifications and results are expressed in A2A's own data model rather than board-private JSON.

Non-goal: replacing the browser↔server API. The React client keeps `/api` + `/ws`; A2A is the machine-to-machine boundary. A2A is also not a tool protocol — provider-internal tool calls stay as they are (MCP territory, per the spec's "What A2A is not").

## 2. What exists today (and what A2A replaces)

| Surface | Today | A2A equivalent |
|---|---|---|
| Inbound work from Hermes/orchestrators | `POST /api/orchestrations` + `Idempotency-Key`, `SERVICE_TOKENS` scope, `{task, contract:{deepLink}}` response (`routes/orchestrations.ts`) | `SendMessage` / `SendStreamingMessage` on the board's A2A server; board returns an A2A `Task` |
| Follow-up to a running orchestration | `POST /api/orchestrations/:id/message` | `SendMessage` with existing `taskId` (+ `contextId`) |
| Retry | `POST /api/orchestrations/:id/retry` | `SendMessage` with `referenceTaskIds: [failedTaskId]` in the same `contextId` |
| Work handed to a remote executor | `WorkerTaskAssignment` (field allowlist, `shared/types.ts`), pulled via `GET /api/workers/me/assignments` + `POST .../claim` with lease | A2A `Message` with `Part`s sent to the worker's A2A endpoint (transport decision in §5) |
| Progress stream | `AgentEvent[]` POSTed by worker to `/me/tasks/:id/events`, rebroadcast on `/ws` | `TaskStatusUpdateEvent` + `TaskArtifactUpdateEvent` on the A2A stream; `/ws` stays as the client-facing fan-out |
| Blocking question to a human | `agentStatus: awaiting_clarification`, `columnId: pending`, `clarificationRequest/Answer`, command poll | `TASK_STATE_INPUT_REQUIRED` + next `SendMessage` with same `taskId` |
| Cancel | `cancel` worker command | `CancelTask` |
| Executor discovery | `detectAgents()` on PATH + `Worker.agentTypes` / `acceptedLabels` / `acceptedProjectIds` | `AgentCard.skills[]`, `capabilities`, `securitySchemes` at `/.well-known/agent-card.json` |
| Task groups | `TaskGroup` + `GroupQueue` with `maxConcurrency` | group id becomes the A2A `contextId` shared by child tasks; queue stays board-side |
| Result | `summary`, branch/worktree, merge/PR buttons | A2A `Artifact`s (summary text part, diff/branch data part) attached to the task |

Two things already line up almost exactly: the board's task lifecycle is A2A's task lifecycle, and the clarification pause is A2A's `input-required`. That is why this is a wrapping job, not a rewrite.

## 3. Target architecture

```
                 ┌──────────── A2A client ────────────┐
Hermes / other   │                                    │   remote A2A agents
orchestrator ────┼─► Board A2A server  ──────────────►├─► worker (A2A server)
  (A2A client)   │   /.well-known/agent-card.json     │   3rd-party A2A agent
                 │   /a2a/v1  (JSON-RPC + REST)       │
                 └────────────────┬───────────────────┘
                                  │ AgentExecutor bridge
                     TaskRepository / AgentManager / GroupQueue
                                  │
                       /api + /ws  ──► React client (unchanged)
```

The board is **both** an A2A server (accepts delegated work) and an A2A client (delegates work out) — the orchestrator role the protocol is designed for.

## 4. Data model mapping

### 4.1 Task state

Board `agentStatus` + `columnId` → A2A `TaskState` (v1.0 JSON uses the proto enum names):

| Board | A2A |
|---|---|
| `idle`, `columnId: backlog` (queued, not started) | `TASK_STATE_SUBMITTED` |
| `planning`, `executing` | `TASK_STATE_WORKING` |
| `awaiting_clarification` / `columnId: pending` | `TASK_STATE_INPUT_REQUIRED` |
| `complete` (`review` or `done`) | `TASK_STATE_COMPLETED` |
| `failed` (incl. timeout, `worker_offline`) | `TASK_STATE_FAILED` |
| cancelled by user | `TASK_STATE_CANCELED` |
| rejected at admission (bad project, agent unavailable, consent refused) | `TASK_STATE_REJECTED` |

`TASK_STATE_AUTH_REQUIRED` is reserved for a future in-task auth flow (e.g. worker needs `opencode auth login`); today that path fails the task, and modelling it as `auth-required` is a follow-up.

Board column stays board-private: it is derived from state, not sent over the wire. A2A `Task.status.timestamp` maps to `startedAt`/`completedAt`.

### 4.2 Events → status/artifact updates

`AgentEvent.type` already carries an importance classification (`classifyAgentEventImportance`). Mapping rule:

- `detail` events (`thinking`, `output`, `tool_call`, `file_read`, `command_output`) → `TaskStatusUpdateEvent` with `state: TASK_STATE_WORKING`, `final: false`, text `Part`, and the original event in `metadata` under a board extension key.
- `milestone` events (`file_write`, `file_edit`, `command`, `test_result`) → `TaskStatusUpdateEvent` with a structured data `Part` (`file`, `diff`, `command`, `duration`).
- `error` → terminal `TASK_STATE_FAILED` status update, `final: true`.
- `complete` → `TaskArtifactUpdateEvent` carrying the run artifact (summary text part + data part with `branchName`, `baseBranch`, worktree-free git info, token/cost usage), then terminal `TASK_STATE_COMPLETED`.

Usage numbers (`inputTokens`, `outputTokens`, `costUsd`) ride in `metadata` so `WorkerUsageReport` keeps working.

### 4.3 Inbound message shape

`SendMessage` params carry the work request; the board no longer invents a request body:

- `message.parts[0]`: text part = task description (title taken from `metadata.title` or first line);
- `message.parts[n]`: data part `{ project, agentType, priority, baseBranch, branchName, useWorktree, timeoutMinutes, labels, autoStart }` — exactly today's orchestration body, now a `Part` instead of an ad-hoc payload;
- file parts (url or inline) map onto `TaskAttachment`;
- `metadata.provenance` replaces `provenance`/`origin` (same `sanitizeOrigin` allowlist);
- idempotency: A2A §3.3.1 — keep accepting `Idempotency-Key` as an HTTP header on the A2A endpoint and keep `createIdempotent`. Replays return the existing task, as today.

Board-private fields are **never** accepted from a client: `repoPath` stays server-resolved from the project (the current `buildTask` + `ALLOWED_REPO_ROOTS` behaviour is preserved).

### 4.4 Outbound message shape (board → executor)

`WORKER_TASK_ASSIGNMENT_KEYS` is the existing, type-enforced "what may leave the board" allowlist and it keeps that job: the assignment object is serialised into one data `Part`. Host paths still never leave the board. The compile-time coverage check in `shared/types.ts` must be extended to the A2A serialiser so a new field cannot silently escape.

### 4.5 Agent Card

Board card (`GET /.well-known/agent-card.json`), one skill per thing the board can be asked to do:

| Skill id | What it means |
|---|---|
| `code-task` | implement a change in a project repo (today's orchestration) |
| `code-review` | review an existing implementation (`mode: 'review'`) |
| `task-group` | run 2–20 related child tasks with bounded parallelism |

`capabilities`: `streaming: true` (SSE), `pushNotifications: true` (webhooks — the natural fit for hour-long runs), `extendedAgentCard: true` (project list only for authenticated callers). `securitySchemes`: HTTP bearer, mapped to existing `API_KEY` / `SERVICE_TOKENS` scopes.

Worker card (served by the worker, or synthesised by the board in pull mode — §5): skills derived from `agentTypes`, tags from `acceptedLabels`, `acceptedProjectIds` as a board extension — consent stays explicit and worker-owned.

## 5. The one hard problem: workers are pull-based

A2A servers are HTTP endpoints the client dials. Today **the server never connects to a worker** (`docs/architecture.md`) — workers sit behind NAT and poll. Three ways out:

| Option | How | Cost | Verdict |
|---|---|---|---|
| **A. Worker as A2A server** | worker runs `jsonRpcHandler` on a reachable URL; board becomes an A2A client via `ClientFactory` | needs inbound reachability (LAN, tunnel, or mTLS gateway); breaks the current zero-config laptop worker | Correct long-term, wrong as step 1 |
| **B. Keep pull, A2A semantics only** | board stays the A2A server; worker is an internal executor driven by the existing claim/lease/poll REST, but every payload is an A2A `Message`/`Part` and every report an A2A event | no reachability change, no worker-fleet break; declared honestly as a custom binding (spec §5.8) | **Recommended for phase 1–2** |
| **C. Reverse-tunnel / long-poll binding** | worker holds a long-lived connection (WS or SSE) over which the board issues A2A requests | real A2A semantics with no inbound ports; most work | Phase 4, if A is unacceptable |

Recommendation was B; **decision is A: full A2A.** Workers expose a real A2A server and the board dials them. Consequences, which phase 2 must deliver:

- the worker CLI gains an A2A server (`jsonRpcHandler` + `restHandler` + card) bound to a configurable host/port, default loopback;
- enrollment must record a reachable `a2aEndpoint` (LAN URL, or a tunnel URL the worker discovers) and the board must verify reachability by fetching the worker's Agent Card before marking it `online`;
- heartbeat becomes a card fetch / `ListTasks` probe instead of an inbound poll — `WORKER_STALE_AFTER_MS` semantics are kept but driven board-side;
- the claim/lease machinery collapses: the board assigns by calling `SendMessage` on exactly one worker, so leases are replaced by "the task is owned by the agent we sent it to", with `CancelTask` for takeback. `workerClaimTokenHash`/`workerLeaseExpiresAt` become dead fields to drop;
- laptop workers behind NAT need a tunnel; `docs/workers.md` must document that as a prerequisite, and the preflight should fail loudly when the board cannot reach the worker.

Third-party A2A agents work the same way with no extra code — that is the payoff.

## 6. Code plan

New workspace package **`packages/a2a`** (`@ai-agent-board/a2a`), dependency-light, shared by server and worker:

- `mapping/state.ts` — `agentStatus` + `columnId` ⇄ `TaskState` (table in §4.1), exhaustive switches.
- `mapping/events.ts` — `AgentEvent` ⇄ `TaskStatusUpdateEvent`/`TaskArtifactUpdateEvent`.
- `mapping/assignment.ts` — `WorkerTaskAssignment` ⇄ `Part[]`, reusing `WORKER_TASK_ASSIGNMENT_KEYS` with the same compile-time coverage guard.
- `cards.ts` — board and worker `AgentCard` builders.
- `extension.ts` — the board extension URI + metadata keys (board event type, importance, usage, consent, deep link).

Server:

- `src/a2a/executor.ts` — `AgentExecutor`: `execute()` admits the request (project resolve, agent availability, consent), creates/updates the task through `TaskRepository`, then publishes A2A events; `cancelTask()` routes to the existing cancel path. Long runs use `keepBusAlive` + `DefaultPushNotificationSender`, which is exactly what `DefaultRequestHandler` supports for executors that outlive their own events.
- `src/a2a/task-store.ts` — `TaskStore` backed by the existing repositories (not `InMemoryTaskStore`, and not a second source of truth).
- `src/a2a/router.ts` — `agentCardHandler` + `jsonRpcHandler` + `restHandler` mounted at `/a2a/v1`, behind the existing auth middleware mapped to A2A security schemes.
- `src/a2a/client.ts` — outbound `ClientFactory` for workers with an `a2aEndpoint` and for third-party A2A agents; new `AgentType` value `a2a` with the endpoint/card stored per worker.
- `routes/orchestrations.ts` — kept as a thin deprecated adapter over the same executor for one release, then removed.

Worker: `WorkerTaskAssignment` decoding and event emission move to `@ai-agent-board/a2a`; optional `--a2a-serve` flag exposes the worker as a real A2A server (option A).

Shared: `AgentType` gains `'a2a'`; `Worker` gains `a2aEndpoint?`/`agentCardUrl?`; task gains nothing — `contextId` is derived from `groupId` or minted per task and stored alongside `externalKey`.

## 7. Phases

| Phase | Deliverable | Gate evidence |
|---|---|---|
| 1 | `packages/a2a` mappings + board Agent Card + `/a2a/v1` JSON-RPC **and** REST: `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`. `/api/orchestrations` **replaced** by the A2A endpoint (route deleted, `integrations/hermes-agent-board` updated) | unit tests on mappings (round-trip every `AgentEventType` and every state); `a2a-cli` discovers the card and sends a task that appears on the board; e2e for the removed route's replacement |
| 2 | Worker becomes an A2A server (`--a2a-serve`, card, `SendMessage` executor); board dials workers as an A2A client; reachability check at enrollment; claim/lease path removed | worker e2e rewritten against the A2A path; integration test with a local A2A echo agent |
| 3 | `SendStreamingMessage` + `SubscribeToTask` (SSE) fed by the existing event stream; push-notification configs for hour-long runs | e2e: stream a run end to end; webhook delivery test |
| 4 | `input-required` round trip (clarification), `referenceTaskIds` retry, artifacts on completion, `contextId` = group | e2e: clarification answered over A2A resumes the run |
| 5 | Docs (`docs/architecture.md`, `docs/integrations.md`, `docs/workers.md`, new `docs/a2a.md`); conformance pass with the A2A CLI | `npm run gate:required` green; CLI discovery + send + get + cancel against a local board |

Phase 1 is the only phase that removes an existing API; phases 2–4 are additive on top of it.

### Progress

- **Done:** `packages/a2a` (`@ai-agent-board/a2a`) — `extension.ts`, `state.ts`, `events.ts`, `assignment.ts`, `cards.ts` with 22 unit tests (`npm run test:a2a`): every `AgentEventType` round-trips, every `agentStatus` maps to a defined `TaskState`, and the assignment allowlist rejects board-private fields such as `repoPath`.
- **Next (phase 1 remainder):** server `AgentExecutor` + repository-backed `TaskStore`, `/a2a/v1` JSON-RPC + REST router and `/.well-known/agent-card.json`, removal of `/api/orchestrations`, `integrations/hermes-agent-board` moved over, `a2a-cli` conformance run.


## 8. Security notes

- A2A adds no new trust assumptions if the card's `securitySchemes` map onto today's tokens: full-access `API_KEY`, scoped `SERVICE_TOKENS` (`jira:import`-style scopes extend to `a2a:send`), per-worker tokens for the worker binding.
- Outbound client calls must honour `network-policy.ts`: an A2A endpoint URL is attacker-influenced input, so it needs the same allowlist/SSRF treatment as the loopback session-bridge URL normalisation already applied in `routes/workers.ts`.
- Push-notification webhook URLs are client-supplied: validate scheme/host, require a token, never follow redirects.
- Inbound `Part`s are untrusted: enforce `MAX_TITLE_LENGTH`/`MAX_DESCRIPTION_LENGTH`, media-type allowlist, and attachment size limits; never accept `repoPath`, `worktreePath`, or any host path from a peer.
- Agent Card signing (spec §8.4) is available via `jose` if cards are ever served publicly.

## 9. Decisions (made)

1. **Worker transport — option A, full A2A.** Workers expose a reachable A2A server (LAN or tunnel); the board dials them. Pull/claim/lease is removed in phase 2. See §5.
2. **`/api/orchestrations` — replaced outright in phase 1.** No deprecation window; `integrations/hermes-agent-board` moves to the A2A endpoint in the same change.
3. **Bindings — JSON-RPC + HTTP/REST**, both from `@a2a-js/sdk`. No gRPC (would pull in `@grpc/grpc-js`).
4. **First client — the official `a2a-cli`.** Phase 1 is done when `a2a-cli` can discover the board's card, send a coding task, get it, list tasks and cancel it against a local board.
