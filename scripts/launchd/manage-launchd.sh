#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/wrappers/common.sh"

repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
templates_dir="$script_dir/templates"
wrappers_dir="$script_dir/wrappers"
launch_agents_dir=${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
logs_dir=${AI_AGENT_BOARD_LOG_DIR:-$HOME/Library/Logs/ai-agent-board/launchd}

server_label="com.ai-agent-board.server"
client_label="com.ai-agent-board.client"
opencode_label="com.ai-agent-board.opencode"

refresh_plist_paths() {
  server_plist="$launch_agents_dir/$server_label.plist"
  client_plist="$launch_agents_dir/$client_label.plist"
  opencode_plist="$launch_agents_dir/$opencode_label.plist"
}

server_template="$templates_dir/com.ai-agent-board.server.plist.template"
client_template="$templates_dir/com.ai-agent-board.client.plist.template"
opencode_template="$templates_dir/com.ai-agent-board.opencode.plist.template"

server_wrapper="$wrappers_dir/board-server.sh"
client_wrapper="$wrappers_dir/vite-client.sh"
opencode_wrapper="$wrappers_dir/opencode-serve.sh"

usage() {
  cat <<EOF
Usage:
  $0 install --private-env-file PATH [--repo-root PATH] [--launch-agents-dir PATH] [--logs-dir PATH]
  $0 unload [all|server|client|opencode]
  $0 status [all|server|client|opencode]
  $0 logs [all|server|client|opencode]

EOF
}

escape_sed() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    | sed 's/[\\&|]/\\&/g'
}

render_template() {
  template=$1
  output=$2
  label=$3
  wrapper=$4
  repo=$5
  private_env=$6
  log_dir=$7

  sed \
    -e "s|__LABEL__|$(escape_sed "$label")|g" \
    -e "s|__WRAPPER__|$(escape_sed "$wrapper")|g" \
    -e "s|__REPO_ROOT__|$(escape_sed "$repo")|g" \
    -e "s|__PRIVATE_ENV_FILE__|$(escape_sed "$private_env")|g" \
    -e "s|__LOG_DIR__|$(escape_sed "$log_dir")|g" \
    "$template" > "$output"
}

ensure_private_env() {
  private_env_file=$1
  [ -f "$private_env_file" ] || aiab_error "Missing private env file: $private_env_file"
  aiab_load_private_env_file "$private_env_file"
  aiab_validate_loopback_http_url "${OPENCODE_BASE_URL:-http://127.0.0.1:4098}"
}

write_service() {
  template=$1
  output=$2
  label=$3
  wrapper=$4

  render_template "$template" "$output" "$label" "$wrapper" "$repo_root" "$private_env_file" "$logs_dir"
  chmod 0644 "$output"
}

show_bootstrap_hint() {
  printf '%s\n' "Next steps:" 
  printf '  launchctl bootstrap gui/$(id -u) %s\n' "$server_plist"
  printf '  launchctl bootstrap gui/$(id -u) %s\n' "$client_plist"
  printf '  launchctl bootstrap gui/$(id -u) %s\n' "$opencode_plist"
}

status_one() {
  label=$1
  plist=$2
  if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    state="loaded"
  else
    state="unloaded"
  fi

  printf '%s: %s (%s)\n' "$label" "$state" "$plist"
}

tail_logs() {
  title=$1
  out_log=$2
  err_log=$3

  printf '%s\n' "$title"
  tail -n 20 -f "$out_log" "$err_log"
}

unload_one() {
  label=$1
  plist=$2
  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  fi
  rm -f "$plist"
}

command=${1:-}
case "$command" in
  install)
    shift
    private_env_file=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --private-env-file)
          private_env_file=${2:-}
          shift 2
          ;;
        --repo-root)
          repo_root=${2:-}
          shift 2
          ;;
        --launch-agents-dir)
          launch_agents_dir=${2:-}
          shift 2
          ;;
        --logs-dir)
          logs_dir=${2:-}
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          aiab_error "Unknown option: $1"
          ;;
      esac
    done

    [ -n "$private_env_file" ] || aiab_error "--private-env-file is required"
    ensure_private_env "$private_env_file"
    refresh_plist_paths

    mkdir -p "$launch_agents_dir" "$logs_dir"
    : > "$logs_dir/server.out.log"
    : > "$logs_dir/server.err.log"
    : > "$logs_dir/client.out.log"
    : > "$logs_dir/client.err.log"
    : > "$logs_dir/opencode.out.log"
    : > "$logs_dir/opencode.err.log"

    write_service "$server_template" "$server_plist" "$server_label" "$server_wrapper"
    write_service "$client_template" "$client_plist" "$client_label" "$client_wrapper"
    write_service "$opencode_template" "$opencode_plist" "$opencode_label" "$opencode_wrapper"

    printf 'Installed launchd plists into %s\n' "$launch_agents_dir"
    show_bootstrap_hint
    ;;
  unload)
    shift || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --launch-agents-dir)
          launch_agents_dir=${2:-}
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          break
          ;;
      esac
    done
    refresh_plist_paths
    target=${1:-all}
    case "$target" in
      all)
        unload_one "$server_label" "$server_plist"
        unload_one "$client_label" "$client_plist"
        unload_one "$opencode_label" "$opencode_plist"
        ;;
      server)
        unload_one "$server_label" "$server_plist"
        ;;
      client)
        unload_one "$client_label" "$client_plist"
        ;;
      opencode)
        unload_one "$opencode_label" "$opencode_plist"
        ;;
      -h|--help)
        usage
        ;;
      *)
        aiab_error "Unknown unload target: $target"
        ;;
    esac
    ;;
  status)
    shift || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --launch-agents-dir)
          launch_agents_dir=${2:-}
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          break
          ;;
      esac
    done
    refresh_plist_paths
    target=${1:-all}
    case "$target" in
      all)
        status_one "$server_label" "$server_plist"
        status_one "$client_label" "$client_plist"
        status_one "$opencode_label" "$opencode_plist"
        ;;
      server)
        status_one "$server_label" "$server_plist"
        ;;
      client)
        status_one "$client_label" "$client_plist"
        ;;
      opencode)
        status_one "$opencode_label" "$opencode_plist"
        ;;
      -h|--help)
        usage
        ;;
      *)
        aiab_error "Unknown status target: $target"
        ;;
    esac
    ;;
  logs)
    shift || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --launch-agents-dir)
          launch_agents_dir=${2:-}
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          break
          ;;
      esac
    done
    refresh_plist_paths
    target=${1:-all}
    case "$target" in
      all)
        tail_logs "server" "$logs_dir/server.out.log" "$logs_dir/server.err.log" &
        pid1=$!
        tail_logs "client" "$logs_dir/client.out.log" "$logs_dir/client.err.log" &
        pid2=$!
        tail_logs "opencode" "$logs_dir/opencode.out.log" "$logs_dir/opencode.err.log" &
        pid3=$!
        wait "$pid1" "$pid2" "$pid3"
        ;;
      server)
        tail_logs "server" "$logs_dir/server.out.log" "$logs_dir/server.err.log"
        ;;
      client)
        tail_logs "client" "$logs_dir/client.out.log" "$logs_dir/client.err.log"
        ;;
      opencode)
        tail_logs "opencode" "$logs_dir/opencode.out.log" "$logs_dir/opencode.err.log"
        ;;
      -h|--help)
        usage
        ;;
      *)
        aiab_error "Unknown logs target: $target"
        ;;
    esac
    ;;
  ''|-h|--help)
    usage
    ;;
  *)
    aiab_error "Unknown command: ${command:-<none>}"
    ;;
esac
