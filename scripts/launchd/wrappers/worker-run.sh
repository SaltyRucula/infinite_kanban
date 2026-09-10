#!/bin/sh
set -eu

repo_root=${AI_AGENT_BOARD_REPO_ROOT:?AI_AGENT_BOARD_REPO_ROOT is required}

# Uses the persisted registration in ~/.agentboard-worker/config.json (written
# by `agentboard-worker register`); no private env file needed here.
cd "$repo_root/packages/worker"
exec npm run dev
