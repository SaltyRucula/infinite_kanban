# Workers

A **worker** is a small process that runs agent tasks on a machine that has your repositories and an authenticated OpenCode CLI. The board server hands tasks to workers; the worker runs the agent locally and streams events back. Tasks started from the board must be assigned to a worker before they can run.

## How a worker runs a task

1. The worker registers once and receives its own token.
2. It polls the server for tasks assigned to it and requested to run, then claims one with a short, renewable lease.
3. It runs the agent in its configured workspace and uploads events, which the board streams live.
4. While the task runs, it polls for commands from the board (follow-up messages, clarification answers, cancel).
5. It reports the result (`complete` or `failed`) and releases the task. Sending a follow-up message to a finished worker task adds it to the task description and queues a fresh run.

If a worker stops heartbeating, its lease expires and the server marks the task failed so it can be retried.

## Prerequisites

- Node.js 22+ and this repository checked out on the worker machine.
- The `opencode` CLI installed and authenticated. The default model (`github-copilot/claude-sonnet-5`) needs GitHub Copilot auth; set `OPENCODE_WORKER_MODEL` to use another provider.
- A registration token: the server's `API_KEY`, or a `SERVICE_TOKENS` entry with the `workers:register` scope (see [Configuration › Service tokens](configuration.md#service-tokens)).
- A workspace directory containing the repositories the worker should operate on. The agent picks the matching repository from the task title and description.

## Register and run

```bash
npm install
npm run worker:build

# Register once. Omitted options are prompted for interactively.
node packages/worker/dist/cli.js register \
  --serverUrl http://localhost:8080 \
  --token <registration-token> \
  --name my-laptop \
  --workspacePath ~/Development \
  --agentTypes opencode

# Start polling for tasks
node packages/worker/dist/cli.js run
```

During development you can use `npm run worker:dev` (runs `src/cli.ts run` with reload) instead of building.

Registration writes two files with `0600` permissions:

| File | Contents |
|------|----------|
| `~/.agentboard-worker/config.json` | Worker id, worker token, server URL |
| `~/.agentboard-worker/workspace.json` | Workspace path and runner profile |

## Runner profiles

`workspace.json` selects how the worker drives OpenCode:

```json
{ "workspacePath": "/home/you/Development", "runner": { "kind": "opencode-server", "agent": "build" } }
```

| `runner.kind` | Behaviour |
|---------------|-----------|
| `agent-sdk` (default when `runner` is omitted) | Uses the `@codewithdan/agent-sdk-core` OpenCode provider. Set `OPENCODE_BASE_URL` to reuse an existing loopback OpenCode server. |
| `opencode-server` | Starts `opencode serve` and drives the named OpenCode `agent` directly. Runs headlessly: interactive permission prompts and the `question` tool are disabled (the agent ends with a written question instead), and stalled tool calls are retried. |

`register` only writes `workspacePath`; add the `runner` block yourself (the Docker entrypoint does this automatically).

## Docker

The deploy stack ships an optional worker image with the `opencode` CLI preinstalled. It registers on first start and keeps its credentials in a volume.

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
| `WORKER_HOST_WORKSPACE` | _(required)_ | Host directory with your repositories, mounted read-write at `/workspace`. |

## Opening a live session

While a task runs, the **Open OpenCode session** button on the task card and agent panel links to the worker's session bridge, a loopback-only redirect into the worker's local OpenCode UI. It only works from the worker machine itself. Pin the bridge port with `OPENCODE_SESSION_BRIDGE_PORT` if you need a stable URL.
