#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/common.sh"

repo_root=${AI_AGENT_BOARD_REPO_ROOT:?AI_AGENT_BOARD_REPO_ROOT is required}
private_env_file=${AI_AGENT_BOARD_PRIVATE_ENV_FILE:?AI_AGENT_BOARD_PRIVATE_ENV_FILE is required}

aiab_load_private_env_file "$private_env_file"

if [ -n "${HOST:-}" ]; then
  aiab_validate_loopback_host "$HOST" || aiab_error "HOST must stay loopback-only"
fi

if [ -n "${VITE_ALLOWED_HOSTS:-}" ]; then
  aiab_validate_loopback_host_list "$VITE_ALLOWED_HOSTS"
fi

cd "$repo_root"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8081}"
export API_URL="${API_URL:-http://127.0.0.1:8080}"
export VITE_ALLOWED_HOSTS="${VITE_ALLOWED_HOSTS:-localhost,127.0.0.1}"
exec npm run dev:client
