#!/usr/bin/env bash
# Evidence command for the board-owned workflow: install workspace dependencies
# in the endpoint's isolated clone, then run the progress spec.
#
# The endpoint clones from git, so node_modules is absent by design. Scripts are
# skipped because the worker suite does not need the native sqlite binding, and
# devDependencies are forced on because this machine's npm sets omit=dev.
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
unset NODE_ENV

if [ ! -d node_modules ]; then
  npm ci --include=dev --ignore-scripts --no-audit --fund=false >/dev/null 2>&1
fi

# Workspace packages are symlinked, so the worker imports their built output.
# Without this the suite dies on a missing @ai-agent-board/a2a/dist file.
npm run build:shared >/dev/null 2>&1
npm run build:a2a >/dev/null 2>&1
npm run build -w @ai-agent-board/opencode-compat >/dev/null 2>&1

node --import tsx/esm --test --test-timeout=30000 packages/worker/tests/execution-progress.test.ts
