# Architecture

A high-level map of how Infinite Kanban works. Code layout and commands are in [Development](development.md).

## Components

```
Browser ── REST /api + WebSocket /ws ──▶ Server (Express, :8080) ──▶ SQLite or PostgreSQL
                                           │  ▲
                   assignments, commands   │  │  claims, events, results
                                           ▼  │
                                        Workers (packages/worker) ──▶ OpenCode in the worker's workspace
```

- **Client:** React 19, Vite, Tailwind 4, Framer Motion, `@dnd-kit` for drag and drop, and xterm.js for the terminal-style event viewer. In development Vite proxies `/api` and `/ws` to the server.
- **Server:** Express routes split by concern (`tasks`, `agent`, `git`, `groups`, `templates`, `projects`, `workers`, `orchestrations`, `jira`, `attachments`), a WebSocket broadcaster, and repositories for SQLite (`better-sqlite3`) and PostgreSQL (`pg`) behind shared interfaces.
- **Workers:** pull-based executors. The server never connects to a worker; workers poll it over REST with their own token. See [Workers](workers.md).
- **Shared:** types (`Task`, `TaskGroup`, `AgentEvent`, …) and validators used by every package.

## Task lifecycle

Columns: **Backlog → In Progress → Review → Done**, plus **Pending** for tasks waiting on a human answer. Allowed moves are defined in `VALID_TRANSITIONS` (`shared/constants.ts`); Pending is reserved for the clarification flow and cannot be entered by dragging.

Agent status runs `idle → planning → executing → complete | failed`, with `awaiting_clarification` while an agent waits for an answer. On restart, tasks left `planning` or `executing` without a live session are reset to `failed`.

## Execution paths

- **Board runs go through workers.** Starting a task from the board requires assigning it to a worker. The server records the run request; the assigned worker claims it with a renewable lease, runs it, streams events, and reports the result. Follow-ups, clarification answers, and cancellation are queued as commands the worker polls. A lease that stops renewing marks the task failed (`worker_offline`).
- **Integrations can run on the server.** Orchestration requests and Jira auto-start queue runs without a worker; the server's durable run dispatcher claims them and executes them in-process through `AgentManager`.

## Agents and the provider pattern

Agents are accessed through the `AgentProvider` / `AgentSession` interfaces from [`@codewithdan/agent-sdk-core`](https://www.npmjs.com/package/@codewithdan/agent-sdk-core):

- `AgentProvider` creates sessions and reports availability; `AgentSession` executes a prompt, accepts follow-ups, emits events, and supports abort.
- `AgentManager` (server) orchestrates in-process sessions with timeouts, event caching, clarification pauses, and cleanup.
- **OpenCode is the only supported agent type.** Availability is detected at startup and can be refreshed with `POST /api/agents/refresh`. Legacy agent values stored by older versions (Copilot, Claude Code, Codex, Hermes, OpenClaw) are read as `opencode`.

## Events and streaming

Provider events are normalized into `AgentEvent`s (thinking, tool calls, file reads and edits, commands and output, errors, completion), persisted to the database, and broadcast over the WebSocket. The agent panel coalesces consecutive thinking and output events for readability.

## Timeouts and event retention

- Each run defaults to 60 minutes (`AGENT_TIMEOUT_MS`). A task's **Time limit** overrides it from 1–240 minutes; integrations send `timeoutMinutes`. Retry timed-out orchestrations on the same card (see [Integrations](integrations.md#typical-flow)).
- A longer limit does not resend context by itself: the provider manages its own context window, and the board only forwards the task and consumes events. Longer runs can still make more model calls and produce more output.
- The server keeps an in-memory LRU cache of up to 2,000 events per task for 200 tasks, and coalesces rapid output for WebSocket delivery. Raw events stay in the database until the task is rerun or deleted, so monitor the `events` table and archive or delete high-volume tasks according to your retention policy.

## Task groups

A group is a parent card with 2–20 child tasks and a parallelism setting (locked once running). All children must be assigned to workers before a group runs. Groups move as a single card and advance to Review when every child completes.

## Git workflow

Tasks can run on their own branch in a git worktree. From Review, **Merge to main** merges the branch locally (serialized per repository to avoid checkout races, aborting on conflict), and **Create PR** appears when the repository has a remote. Worktrees are cleaned up after a successful merge, PR creation, or archival.

## Security model

- Optional full-access `API_KEY` Bearer token for the API and WebSocket, plus narrowly scoped `SERVICE_TOKENS` for integrations. Workers authenticate with per-worker tokens.
- Repository paths are validated against an allowlist (`ALLOWED_REPO_ROOTS`).
- WebSocket upgrades check `Host` and `Origin` allowlists.
- Server and client bind to loopback by default; see [Deployment](deployment.md#security-checklist).
