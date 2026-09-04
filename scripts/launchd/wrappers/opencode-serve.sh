#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/common.sh"

private_env_file=${AI_AGENT_BOARD_PRIVATE_ENV_FILE:?AI_AGENT_BOARD_PRIVATE_ENV_FILE is required}

aiab_load_private_env_file "$private_env_file"

# Do not remove: isolates this daemon's session/message storage from any
# other opencode process on the host. Without it, task retries can corrupt
# or delete sessions belonging to unrelated opencode usage (see git blame).
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share/ai-agent-board-opencode}"

# Do not remove: XDG_DATA_HOME above isolates session/message storage but
# also relocates auth.json (LLM provider credentials), so without this the
# daemon has no provider auth and every prompt silently no-ops instead of
# erroring (see git blame). Link, don't copy: OAuth tokens get refreshed in
# place, and a stale copy would silently drift out of sync.
shared_opencode_data_dir="$HOME/.local/share/opencode"
isolated_opencode_data_dir="$XDG_DATA_HOME/opencode"
mkdir -p "$isolated_opencode_data_dir"
for credential_file in auth.json mcp-auth.json; do
  if [ -f "$shared_opencode_data_dir/$credential_file" ] && [ ! -e "$isolated_opencode_data_dir/$credential_file" ]; then
    ln -s "$shared_opencode_data_dir/$credential_file" "$isolated_opencode_data_dir/$credential_file"
  fi
done

# Do not change to 4096: that is the OpenCode CLI's own default/auto-attach
# port, which an interactive opencode session on this host may already be
# using. Sharing it puts this daemon and an interactive session on the same
# live process, not just the same storage (see git blame).
#
# Do not launch this from the board repo directory: OhMyOpenCode's
# live-server-route registers a running opencode server per PROJECT
# DIRECTORY, not per port. An interactive session working in this same repo
# would get silently rerouted onto this daemon and contend with real task
# execution ("fetch failed" under load) even on a dedicated port. cd here
# first so this daemon's own directory never matches an active project.
cd "$isolated_opencode_data_dir"
exec opencode serve --hostname 127.0.0.1 --port 4098
