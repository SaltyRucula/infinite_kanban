#!/usr/bin/env bash
# Evidence command for board-owned workflow changes: install dependencies in the
# endpoint's isolated clone, build the workspace packages the server imports,
# then run the workflow coordinator suites.
set -euo pipefail

export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
unset NODE_ENV

if [ ! -d node_modules ]; then
  npm ci --include=dev --ignore-scripts --no-audit --fund=false >/dev/null 2>&1
fi

npm run build:shared >/dev/null 2>&1
npm run build:a2a >/dev/null 2>&1

node --import tsx/esm --test --test-timeout=60000 \
  packages/server/tests/board-workflow.test.ts \
  packages/server/tests/board-workflow-events.test.ts
