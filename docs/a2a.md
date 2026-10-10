# A2A on the board

The board speaks [A2A](https://a2a-protocol.org/latest/specification/) **v1.0** in both directions:

- **As a server** — another agent or an orchestrator sends work to the board, which admits it as a card and reports it as an A2A task.
- **As a client** — the board dials agents registered in its trusted directory (see `docs/proposals/a2a-first-rework.md`).

A2A is agent-to-agent: it carries *work*, not tool calls. Provider-internal tool use stays where it is (MCP territory).

## Endpoints

| Path | Purpose | Auth |
|------|---------|------|
| `GET /.well-known/agent-card.json` | Discovery. Public by design (spec §8.2) — it is metadata and carries no task data. | none |
| `POST /a2a/v1` | JSON-RPC binding (`SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`). | see below |
| `/a2a/v1/*` | HTTP+JSON (REST) binding of the same methods, e.g. `POST /a2a/v1/message:send`, `GET /a2a/v1/tasks/{id}`. | see below |

gRPC is deliberately not offered.

### Authentication

Auth is on only when the board has credentials configured, mirroring `/api`:

- `API_KEY` — full access bearer.
- `SERVICE_TOKENS` — scoped credentials; A2A requires the **`a2a:send`** scope.

With neither set the board is open and the card advertises no security scheme. That is a legitimate posture for a private network, and it is what a local run or a LAN deployment does.

```bash
curl -H "Authorization: Bearer $TOKEN" http://board.example/a2a/v1 ...
```

### Version negotiation

`A2A-Version: 1.0` is **mandatory** for v1.0 clients (spec §3.6.1); a peer that omits it is assumed to speak 0.3. Only `Major.Minor` participates in negotiation. The board's outbound client keeps a v0.3 dialect for cards that explicitly declare that version, and refuses to guess for anything else.

## Sending work to the board

A minimal request. The first line of the text becomes the card title, the rest its description:

```bash
curl -X POST http://127.0.0.1:8080/a2a/v1 \
  -H 'content-type: application/json' -H 'A2A-Version: 1.0' \
  -d '{
    "jsonrpc": "2.0", "id": "1", "method": "SendMessage",
    "params": { "message": {
      "messageId": "orchestrator-42",
      "role": "ROLE_USER",
      "parts": [{ "text": "Add rate limiting\n\nThe worker event endpoint is unbounded." }],
      "metadata": { "project": "infinite_kanban", "autoStart": true, "priority": "high", "labels": ["backend"] }
    } }
  }'
```

`messageId` is the **idempotency key**: replaying a request returns the original task instead of creating a second card.

### Request metadata

| Field | Meaning |
|-------|---------|
| `project` | **Required.** Project name or id; the board resolves it and takes its repository from there. |
| `autoStart` | Start a run immediately (needs an available agent), or leave the card in backlog. |
| `priority`, `labels`, `agentType`, `baseBranch`, `branchName`, `timeoutMinutes`, `review` | Optional card attributes, validated with the same rules as the REST API. |

### What a peer may not send

Anything deciding **where** work runs is board policy, resolved from the named project: `repoPath`, `worktreePath`, `projectId`, and worker-assignment fields. A request carrying one is **refused, not ignored** — the task terminates as `TASK_STATE_FAILED` naming the offending field, and no card is created. An unknown field is refused the same way, so a typo fails loudly instead of being silently dropped.

A project that cannot host coding work (no repository) yields `TASK_STATE_REJECTED` with the reason in the status message.

## Following a run

A board run takes minutes to an hour, so `SendMessage` returns the **admitted task**, not the finished work. Three ways to follow it:

1. **Poll** `GetTask`.
2. **Stream** — `SendStreamingMessage` (or `SubscribeToTask` to attach to an existing task) opens an SSE stream carrying the board's own progress: `thinking`, file edits, commands and test results arrive as `TaskStatusUpdateEvent`s, the run result as a `TaskArtifactUpdateEvent` named `run-result`. The stream ends on the first terminal state.
3. **Push notifications** — advertised in the card.

Streaming notes:

- A **blocking** `SendMessage` returns as soon as the work is admitted; only streaming calls hold a connection open. This is decided per call (`BoardEventBusManager`), because the SDK's blocking path otherwise waits for the whole run.
- Board progress reaches the stream from the same broadcast the browser UI uses, so a streaming peer and the board UI see the same run — including work executed by a remote worker.
- A run that never reports a terminal state (crashed worker, dead provider) ends the stream after `DEFAULT_RELAY_MAX_DURATION_MS` (25h) with the task's current state, rather than holding the subscriber forever.

### Board extension

Board-specific detail rides in A2A `metadata` under the extension URI `https://github.com/SaltyRucula/infinite_kanban/a2a/board/v1`, so a board-aware peer can round-trip an `AgentEvent` losslessly while a foreign client still sees plain text and data parts. Keys are in `packages/a2a/src/extension.ts`.

### State mapping

| Board | A2A |
|-------|-----|
| `idle` / backlog | `TASK_STATE_SUBMITTED` |
| `planning`, `executing` | `TASK_STATE_WORKING` |
| `awaiting_clarification` | `TASK_STATE_INPUT_REQUIRED` |
| `complete` | `TASK_STATE_COMPLETED` |
| `failed` | `TASK_STATE_FAILED` |
| stopped over A2A | `TASK_STATE_CANCELED` |
| refused at admission | `TASK_STATE_REJECTED` |

`contextId` is the task's group id when it has one, otherwise `task-<id>` — so the children of a task group share one A2A context, which is what makes a cross-repo change one conversation (#97).

The board has no cancelled column: a stopped run is recorded as `failed` (keeping it retryable in the UI) while A2A reports `TASK_STATE_CANCELED` from an in-memory `CancellationLog`. A cancellation that outlives a restart degrades to `failed`, which is the board's own truth.

## Answering a clarification

A task in `TASK_STATE_INPUT_REQUIRED` is waiting on a human or a peer. Send a follow-up message carrying that task's id, and the answer resumes the paused session.

## Conformance check

`scripts/a2a-conformance.mjs` drives a running board with the **official `@a2a-js/sdk` client** — not curl, and not the board's own code — so a pass says something about interop rather than internal consistency. It exits with the number of failed checks.

```bash
# board must be running, with a project that has a repository
node scripts/a2a-conformance.mjs http://127.0.0.1:8080 conformance
# authenticated board:
A2A_TOKEN=<token> node scripts/a2a-conformance.mjs https://board.example conformance
```

Current result against a local board:

```
PASS  agent card is served at /.well-known/agent-card.json  — Infinite Kanban Board v0.1.0; JSONRPC@1.0, HTTP+JSON@1.0
PASS  card advertises streaming capability  — streaming: true
PASS  SendMessage (JSON-RPC) admits work and returns a task  — task 5db1ef0b state TASK_STATE_SUBMITTED
PASS  SendMessage (HTTP+JSON) admits work and returns a task  — task bcd8c9fc
PASS  replaying a messageId returns the same task  — same task id
PASS  GetTask returns the admitted task  — state TASK_STATE_SUBMITTED
PASS  ListTasks pages and reports a total  — totalSize 7, returned 2
PASS  SendStreamingMessage opens a stream that terminates  — first frame: task
PASS  a board-private field is refused, not ignored  — FAILED naming repoPath
PASS  an unknown project is rejected  — REJECTED
PASS  CancelTask reports TASK_STATE_CANCELED  — CANCELED

11/11 checks passed
```

### Known ecosystem quirks

Two findings from running real clients, both upstream rather than board bugs:

1. **`a2a-cli` (PyPI) does not import.** `uvx --from a2a-cli a2a-cli --help` fails with `ImportError: cannot import name 'TaskSendParams' from 'a2a_json_rpc.spec'` — the CLI is pinned against an older `a2a-json-rpc` API. The conformance script uses the JS SDK client for that reason; revisit the CLI when it installs cleanly.
2. **The JS SDK client sends `status: -1` for "no filter"** on `ListTasks`, and the SDK's own server rejects it with `Invalid status filter: -1`, so an unfiltered `listTasks()` fails against a stock server. The board normalizes that sentinel to absent in `normalizeListTasksStatus` (`packages/server/src/a2a/router.ts`); remove the shim once the SDK stops emitting it.

## Running the board locally

```bash
npm run build:shared && npm run build:a2a && npm run build:server
DB_PATH=./data/local.db PORT=8080 HOST=127.0.0.1 \
  AGENT_BOARD_PUBLIC_URL=http://127.0.0.1:8080 node packages/server/dist/index.js
npm run dev:client   # UI on :8081, proxying /api and /ws
```

`AGENT_BOARD_PUBLIC_URL` is what the Agent Card advertises; without it a peer receives the bind address, which is useless from another machine. In the container stack the ingress must proxy `/.well-known/agent-card.json` and `/a2a/` explicitly (`deploy/nginx.conf`), or both fall through to the SPA.

`better-sqlite3` cannot compile against Node 26 (V8 removed `PropertyCallbackInfo::This`); use Node 22, as CI does.

## Where the code lives

| Path | Role |
|------|------|
| `packages/a2a/` | Shared mapping: state, events, assignments, cards, extension keys. Used by the inbound server, the outbound client and the worker. |
| `packages/server/src/a2a/intake.ts` | Admission: parse a peer's message, refuse board-private fields. |
| `packages/server/src/a2a/executor.ts` | Admits work, publishes the task, starts the relay for streaming callers. |
| `packages/server/src/a2a/relay.ts` | Board run → A2A status/artifact updates; ends the stream on a terminal state. |
| `packages/server/src/a2a/event-hub.ts` | In-process fan-out, fed from the WebSocket broadcast. |
| `packages/server/src/a2a/call-context.ts` | Per-call streaming marker and bus-lifetime policy. |
| `packages/server/src/a2a/router.ts` | Card, both bindings, auth. |
| `packages/server/src/services/a2a-workflow-client.ts` | Outbound client with version negotiation. |
| `docs/specs/a2a-protocol-adoption.md` | The protocol spec and decisions behind all of the above. |
