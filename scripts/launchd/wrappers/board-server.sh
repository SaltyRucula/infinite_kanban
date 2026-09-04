#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/common.sh"

repo_root=${AI_AGENT_BOARD_REPO_ROOT:?AI_AGENT_BOARD_REPO_ROOT is required}
private_env_file=${AI_AGENT_BOARD_PRIVATE_ENV_FILE:?AI_AGENT_BOARD_PRIVATE_ENV_FILE is required}

aiab_load_private_env_file "$private_env_file"
aiab_validate_loopback_http_url "${OPENCODE_BASE_URL:-http://127.0.0.1:4098}"

if [ -n "${HOST:-}" ]; then
  aiab_validate_loopback_host "$HOST" || aiab_error "HOST must stay loopback-only"
fi

cd "$repo_root"
export OPENCODE_BASE_URL="${OPENCODE_BASE_URL:-http://127.0.0.1:4098}"
export HOST="${HOST:-127.0.0.1}"
exec npm run dev:server
