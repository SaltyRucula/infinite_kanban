#!/usr/bin/env bash
# Entrypoint for the ai-agent-board worker image.
#
# Reproduces, on every container start:
#   1. `node packages/worker/dist/cli.js register ...`   (only if not yet registered —
#      credentials persist in the ~/.agentboard-worker volume across restarts)
#   2. the workspace.json `runner` patch the CLI's `register` command does NOT
#      apply on its own (it only ever writes { workspacePath }), so the worker
#      would otherwise default to the wrong (agent-sdk) code path.
#
# Configured entirely via env vars (see deploy/.env.example.worker):
#   AGENTBOARD_SERVER_URL   board server base URL, e.g. http://10.190.52.128
#   AGENTBOARD_TOKEN        workers:register bootstrap token
#   AGENTBOARD_WORKER_NAME  worker display name (default: container hostname)
#   AGENTBOARD_AGENT_TYPES  comma-separated agent types (default: opencode)
#   WORKSPACE_PATH          workspace dir inside the container (default: /workspace)
#   RUNNER_AGENT            opencode agent to run tasks with (default: build)
#   OPENCODE_WORKER_MODEL   optional; passed straight through to the worker CLI
set -euo pipefail

CONFIG_DIR="${HOME}/.agentboard-worker"
CONFIG_FILE="${CONFIG_DIR}/config.json"
WORKSPACE_CONFIG_FILE="${CONFIG_DIR}/workspace.json"
WORKSPACE_PATH="${WORKSPACE_PATH:-/workspace}"
RUNNER_AGENT="${RUNNER_AGENT:-build}"

if [ ! -d "${WORKSPACE_PATH}" ]; then
  echo "docker-entrypoint: WORKSPACE_PATH (${WORKSPACE_PATH}) does not exist — mount your repos" \
       "parent dir there, e.g. -v ~/Development:/workspace" >&2
  exit 1
fi

if [ ! -f "${CONFIG_FILE}" ]; then
  : "${AGENTBOARD_SERVER_URL:?AGENTBOARD_SERVER_URL is required for first-run registration}"
  : "${AGENTBOARD_TOKEN:?AGENTBOARD_TOKEN is required for first-run registration}"
  echo "docker-entrypoint: registering worker '${AGENTBOARD_WORKER_NAME:-$(hostname)}' with ${AGENTBOARD_SERVER_URL}"
  node packages/worker/dist/cli.js register \
    --serverUrl "${AGENTBOARD_SERVER_URL}" \
    --token "${AGENTBOARD_TOKEN}" \
    --name "${AGENTBOARD_WORKER_NAME:-$(hostname)}" \
    --workspacePath "${WORKSPACE_PATH}" \
    --agentTypes "${AGENTBOARD_AGENT_TYPES:-opencode}"
else
  echo "docker-entrypoint: reusing existing registration at ${CONFIG_FILE}"
fi

# `register` only ever writes { workspacePath } to workspace.json, so the
# opencode-server runner override has to be applied on every start.
RUNNER_AGENT="${RUNNER_AGENT}" WORKSPACE_PATH="${WORKSPACE_PATH}" WORKSPACE_CONFIG_FILE="${WORKSPACE_CONFIG_FILE}" \
  node -e '
    const fs = require("fs");
    const workspacePath = process.env.WORKSPACE_PATH;
    const agent = process.env.RUNNER_AGENT;
    const file = process.env.WORKSPACE_CONFIG_FILE;
    fs.writeFileSync(
      file,
      JSON.stringify({ workspacePath, runner: { kind: "opencode-server", agent } }, null, 2) + "\n",
      { mode: 0o600 },
    );
  '
echo "docker-entrypoint: workspace runner set to opencode-server (agent=${RUNNER_AGENT})"

exec "$@"
