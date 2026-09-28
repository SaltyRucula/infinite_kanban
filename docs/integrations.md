# Integrations

Infinite Kanban can create and run work from outside the board: through the **orchestration API** (used by the Hermes plugin and other automation) and the **Jira assigned-issue import**. Both authenticate with scoped service tokens; see [Configuration › Service tokens](configuration.md#service-tokens) for how to define them.

## Orchestration API

`/api/orchestrations` is the stable integration facade. It creates a board task in a project, optionally starts it, and returns a deep link to the task.

| Endpoint | Scope | Purpose |
|----------|-------|---------|
| `POST /api/orchestrations` | `orchestrations:create` | Create (and by default start) a task |
| `GET /api/orchestrations/:id` | `orchestrations:read` | Read task status |
| `POST /api/orchestrations/:id/message` | `orchestrations:message` | Send a follow-up message to the running agent |
| `POST /api/orchestrations/:id/retry` | `orchestrations:create` | Retry a failed or timed-out task on the same card |
| `POST /api/agents/refresh` | `agents:read` | Re-detect agent availability |

### Creating a task

Requirements:

- An `Idempotency-Key` header (at most 200 characters). Replaying the same key returns the original task with `200` and `Idempotent-Replay: true`; reusing a key for a different request returns `409`.
- `project`: an exact project id, name, or alias. Aliases are managed through the project create/update APIs. The project must have a repository path.
- `agent` (or `agentType`): a supported agent type (`opencode`).
- `title` (at most 200 characters) and optional `description` (at most 5,000).
- Worktree isolation is mandatory; the branch name is generated from the key and title unless `branchName` is given.

Optional fields: `priority`, `baseBranch` (defaults to the project's default or `main`), `timeoutMinutes` / `timeout_minutes` (1–240), `autoStart` / `auto_start` (default `true`; requires the agent to be ready), and `provenance` metadata.

```bash
curl -X POST http://localhost:8080/api/orchestrations \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Idempotency-Key: chat-4821-msg-17" \
  -H "Content-Type: application/json" \
  -d '{"project":"billing","agent":"opencode","title":"Fix rounding in invoice totals","timeoutMinutes":90}'
```

A new task returns `201`:

```json
{
  "task": { "id": "…", "columnId": "in-progress", "agentStatus": "planning", "…": "…" },
  "contract": { "projectId": "…", "taskId": "…", "deepLink": "https://kanban.example.com/projects/<projectId>/tasks/<taskId>" }
}
```

Deep links use `AGENT_BOARD_PUBLIC_URL` when set and open the task panel directly.

### Typical flow

1. `POST /api/orchestrations` with a stable idempotency key (for example, derived from the chat message id), so retries of the calling tool never create duplicates.
2. Poll `GET /api/orchestrations/:id` until the task is `complete` or `failed`, or send the user the deep link.
3. Use `POST /api/orchestrations/:id/message` to steer a running agent. It returns `409` if no agent is running.
4. If the run failed or timed out, call `POST /api/orchestrations/:id/retry`, optionally with a larger `timeoutMinutes`, so status and history stay on the same card.

### Hermes plugin

[`integrations/hermes-agent-board`](../integrations/hermes-agent-board/README.md) packages this API as Hermes tools (`agent_board_route_task`, `agent_board_get_task`, and others) plus a routing skill. Give it a service token with only the orchestration, project, and agent scopes.

## Jira assigned-issue import

`POST /api/jira/import-assigned` imports the Jira issues assigned to the configured user as backlog tasks. It needs the `JIRA_*` variables from [Configuration › Jira import](configuration.md#jira-import) and, for service tokens, the `jira:import` scope.

```bash
curl -X POST http://localhost:8080/api/jira/import-assigned \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<project-id>"}'   # omit projectId to use the default project
```

Behaviour:

- **Read-only.** The server never writes to Jira. It queries `POST /rest/api/2/search` (Data Center compatible) with `assignee = currentUser() AND statusCategory in ("To Do", "In Progress") ORDER BY updated DESC`. Closed and done issues are excluded.
- **Idempotent.** Tasks are stored with `externalSource: "jira"` and a stable key built from the normalized Jira base URL and issue id, scoped per project. Re-imports skip existing tasks and never overwrite them; only newly created tasks are broadcast to the board.
- **Errors.** Missing configuration returns `503`; Jira auth or upstream failures return a safe `502` with no token leakage; an import already running for the project returns `409`.

### Scheduled import and auto-start

Configure scheduling per project in **Edit Project**:

- Scheduled import is disabled by default. When enabled it runs every 15 minutes; valid intervals are 5–1,440 minutes.
- The **Import Jira** button always runs an import immediately, whatever the schedule.
- Manual and scheduled imports share a per-project overlap lock and persist the last run's time, counts, and error. Schedules resume after a restart.
- **Auto-start** (off by default) queues imported tasks for execution. It is skipped, with an explanatory event on each task, when the project has no usable repository path, no default agent, or the agent is not ready.
