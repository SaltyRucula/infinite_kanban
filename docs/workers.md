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
2. It runs the agent in its configured workspace and uploads events for the board to stream live.
3. While the task runs, it polls for follow-up messages, clarification answers, and cancellation commands.
4. It reports `complete` or `failed` and releases the task. A follow-up to a finished worker task queues a fresh run.

If a worker stops heartbeating, its lease expires and the server marks the task failed so it can be retried.

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
