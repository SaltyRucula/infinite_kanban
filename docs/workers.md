# Workers

A **worker** runs agent tasks on a machine that has your repositories and an authenticated OpenCode CLI. The board sends assigned tasks to the worker, which runs the agent locally and streams events back to the board.

## Add a worker

Use the board to create a one-time enrollment command:

1. Open the worker panel and select **Add worker**.
2. Copy the displayed enrollment code and worker start command.
3. On the machine that will run tasks, paste and run:

```bash
npx @ai-agent-board/worker start --code <enrollment-url>
```

The enrollment URL contains a one-time code. Treat it like a password: do not commit it, paste it into tickets, or share it in logs.

`start` runs the worker preflight, registers the machine, and begins polling for assigned tasks. It prompts for a worker name, local workspace directory, and supported agent types when needed. The current directory is the default workspace.

This is the normal onboarding flow. You do not need to edit JSON, craft a registration token, or provide the board server URL manually.

## Prerequisites

Before using the command, prepare the worker machine:

- Node.js 22+.
- The `opencode` CLI. If it is not installed, run:

  ```bash
  npm install --global @opencode/cli
  ```

- An authenticated OpenCode provider. If preflight reports that OpenCode is not authenticated, run:

  ```bash
  opencode auth login
  ```

- A workspace directory containing the repositories the worker should operate on.

The `start` command checks the Node.js version, confirms that `opencode` is available, and verifies that OpenCode has an authenticated provider before registration. Fix any reported prerequisite and run the same command again.

## What registration writes

Enrollment registers one worker and saves its credentials locally. The worker writes these files with `0600` permissions:

| File | Contents |
|------|----------|
| `~/.agentboard-worker/config.json` | Worker id, worker token, and board server URL |
| `~/.agentboard-worker/workspace.json` | Workspace path and runner profile |

Registration also writes the runner block automatically. No hand-editing JSON is required.

### Several workers on one machine

Set `AGENTBOARD_WORKER_HOME` to give a worker its own identity directory:

```bash
AGENTBOARD_WORKER_HOME=~/.agentboard-worker-reviewer \
  npx @ai-agent-board/worker start --code <enrollment-url>
```

Without it, every worker on the host shares `~/.agentboard-worker` and the second registration overwrites the first one's credentials. Setting `HOME` instead does not work: the agent CLIs resolve their own credentials and caches from it, and they will fail to start.

Each worker also needs its own OpenCode session bridge port, via `OPENCODE_SESSION_BRIDGE_PORT`. A worker whose port is already taken exits immediately; the board then shows its task sitting in `planning` until the stranded-task sweep fails it, so check the worker's own log when a run produces no events.

## Runner profiles

The default runner is `agent-sdk`. To use the local OpenCode server runner during enrollment, add runner options to the same start command:

```bash
npx @ai-agent-board/worker start --code <enrollment-url> --runner opencode-server --agent build
```

| `runner.kind` | Behaviour |
|---------------|-----------|
| `agent-sdk` | Uses the `@codewithdan/agent-sdk-core` OpenCode provider. Set `OPENCODE_BASE_URL` to reuse an existing loopback OpenCode server. |
| `opencode-server` | Starts `opencode serve` and drives the named OpenCode agent directly. Interactive permission prompts and the `question` tool are disabled; stalled tool calls are retried. |

The `--agent` option is optional for `opencode-server` and defaults to `build`.

## How a worker runs a task

1. The worker polls for assigned tasks that were requested to run, then claims one with a short, renewable lease.
2. For a project with a portable repository URL, it resolves that identity to its own checkout before starting the agent; board-host paths never leave the board. Legacy tasks without a repository URL still use the configured workspace.
3. While the task runs, it polls for follow-up messages, clarification answers, and cancellation commands.
4. It reports `complete` or `failed` and releases the task. A follow-up to a finished worker task queues a fresh run.

If a worker stops heartbeating, its lease expires and the server marks the task failed so it can be retried.

### Two workers, one task: implement then review

`scripts/demo-two-agents.mjs` runs the whole cycle against a local board as a worked example: it creates a throwaway git repository, enrols an implementer and a reviewer as separate worker processes, has the implementer complete a task, hands the card over, and has the reviewer report a verdict.

```bash
node scripts/demo-two-agents.mjs http://127.0.0.1:8080
```

The handoff is driven by two board mechanisms:

- **`assignedWorkerId`** targets a specific worker. It is a `PATCH /api/tasks/:id` field — task creation does not accept it.
- **Consent** decides what a worker is allowed to take: it must have opted into the task's project and into *every* label on the task. Giving the implementer `--accepted-labels implement` and the reviewer `--accepted-labels review` means relabelling the card is what moves work between them, rather than two eligible workers racing for it.

A run started while the card sits in the Review column carries `mode: 'review'`, which is what puts the second agent in review mode with edits disabled. The verdict is reported in the event stream as `REVIEW_VERDICT: <verdict>` — there is no persisted verdict field. `changes_requested` moves the card back to In Progress; a `pass` leaves it in Review for a human to take to Done, so do not wait on a column change to detect that a review finished.

### Repository-aware workspaces

`workspace.json` may map portable Git repository identities to local checkouts. The keys accept HTTPS, SSH, or `git@host:path` forms; the worker normalizes them before matching. On a mapping hit it fetches the configured checkout. With `cloneRoot`, an unmapped repository is cloned under a stable `host/owner/repository` directory instead.

```json
{
  "workspacePath": "/home/me/projects",
  "repositoryMappings": {
    "github.com/saltyrucula/infinite_kanban": "/home/me/projects/infinite_kanban"
  },
  "cloneRoot": "/home/me/agent-clones",
  "runner": { "kind": "agent-sdk" }
}
```

Set either `repositoryMappings`, `cloneRoot`, or both. Do not put a board-host path in a task description or worker configuration shared with another machine.

## Docker

The deploy stack includes an optional worker image with the `opencode` CLI preinstalled. It registers on first start and keeps credentials in a volume.

```bash
cd deploy
cp .env.example .env   # fill in the worker section
docker compose --env-file .env --profile worker up -d --build worker
```

| Variable (`deploy/.env`) | Default | Description |
|--------------------------|---------|-------------|
| `AGENTBOARD_SERVER_URL` | _(required)_ | Board server URL the worker registers against. |
| `AGENTBOARD_TOKEN` | _(required)_ | Registration token (`workers:register` scope). |
| `AGENTBOARD_WORKER_NAME` | container hostname | Worker display name. |
| `AGENTBOARD_AGENT_TYPES` | `opencode` | Comma-separated agent types; only `opencode` is supported. |
| `RUNNER_AGENT` | `build` | OpenCode agent used by the `opencode-server` runner. |
| `OPENCODE_WORKER_MODEL` | _(see [Configuration](configuration.md#worker))_ | Model override. |
| `WORKER_HOST_WORKSPACE` | _(required)_ | Host directory with repositories, mounted read-write at `/workspace`. |

## Opening a live session

While a task runs, the **Open OpenCode session** button on the task card and agent panel links to the worker's session bridge, a loopback-only redirect into the worker's local OpenCode UI. It only works from the worker machine. Set `OPENCODE_SESSION_BRIDGE_PORT` to pin the bridge port.
