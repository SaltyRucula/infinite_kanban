#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
installer="$script_dir/manage-launchd.sh"

tmp_home=$(mktemp -d "${TMPDIR:-/tmp}/ai-agent-board-launchd.XXXXXX")
trap 'rm -rf "$tmp_home"' EXIT INT TERM

tool_bin="$tmp_home/bin"
mkdir -p "$tool_bin"
cat > "$tool_bin/npm" <<'EOF'
#!/bin/sh
printf 'stub npm %s\n' "$*"
exit 0
EOF
chmod 0755 "$tool_bin/npm"

cat > "$tool_bin/launchctl" <<'EOF'
#!/bin/sh
case "$1" in
  print)
    exit 1
    ;;
  bootout)
    exit 0
    ;;
esac
exit 0
EOF
chmod 0755 "$tool_bin/launchctl"

cat > "$tool_bin/tail" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$tool_bin/tail"

private_env="$tmp_home/private.env"
bad_env="$tmp_home/bad.env"
missing_env="$tmp_home/missing.env"
bad_userinfo_env="$tmp_home/bad-userinfo.env"
bad_empty_userinfo_env="$tmp_home/bad-empty-userinfo.env"
bad_mode_env="$tmp_home/bad-mode.env"
bad_host_env="$tmp_home/bad-host.env"
bad_vite_hosts_env="$tmp_home/bad-vite-hosts.env"
custom_launch_agents_dir="$tmp_home/custom-launch-agents"
special_segment='special-&-backslash-\-plus-+'
special_root_parent="$tmp_home/$special_segment"
special_repo_root="$special_root_parent/repo/root"
special_logs_dir="$special_root_parent/logs/root"
special_launch_agents_dir="$special_root_parent/launch-agents/root"
special_private_env_file="$special_root_parent/env/private&file.env"

cat > "$private_env" <<'EOF'
OPENCODE_BASE_URL=http://127.0.0.1:4096
EOF
chmod 0600 "$private_env"

mkdir -p "$special_repo_root" "$special_logs_dir" "$special_launch_agents_dir" "$(dirname "$special_private_env_file")"
cat > "$special_private_env_file" <<'EOF'
OPENCODE_BASE_URL=http://127.0.0.1:4096
EOF
chmod 0600 "$special_private_env_file"

cat > "$bad_env" <<'EOF'
OPENCODE_BASE_URL=http://example.com:4096
EOF

cat > "$bad_userinfo_env" <<'EOF'
OPENCODE_BASE_URL=http://127.0.0.1:4096@evil.example
EOF

cat > "$bad_empty_userinfo_env" <<'EOF'
OPENCODE_BASE_URL=http://@127.0.0.1:4096
EOF

cat > "$bad_mode_env" <<'EOF'
OPENCODE_BASE_URL=http://127.0.0.1:4096
EOF
chmod 0644 "$bad_mode_env"

cat > "$bad_host_env" <<'EOF'
HOST=0.0.0.0
EOF

cat > "$bad_vite_hosts_env" <<'EOF'
VITE_ALLOWED_HOSTS=localhost,0.0.0.0
EOF

expect_fail() {
  label=$1
  shift
  if "$@" >/dev/null 2>&1; then
    printf 'FAIL: %s unexpectedly succeeded\n' "$label"
    exit 1
  fi
  printf 'PASS: %s rejected as expected\n' "$label"
}

expect_ok() {
  label=$1
  shift
  if ! "$@" >/dev/null 2>&1; then
    printf 'FAIL: %s unexpectedly failed\n' "$label"
    exit 1
  fi
  printf 'PASS: %s accepted as expected\n' "$label"
}

expect_fail "missing private env" env HOME="$tmp_home" "$installer" install --private-env-file "$missing_env"
expect_fail "non-loopback OPENCODE_BASE_URL" env HOME="$tmp_home" "$installer" install --private-env-file "$bad_env"
expect_fail "userinfo OPENCODE_BASE_URL" env HOME="$tmp_home" "$installer" install --private-env-file "$bad_userinfo_env"
expect_fail "empty-userinfo OPENCODE_BASE_URL" env HOME="$tmp_home" "$installer" install --private-env-file "$bad_empty_userinfo_env"
expect_fail "unsafe private env permissions" env HOME="$tmp_home" "$installer" install --private-env-file "$bad_mode_env"

HOME="$tmp_home" PATH="$tool_bin:$PATH" "$installer" install --private-env-file "$private_env"
HOME="$tmp_home" PATH="$tool_bin:$PATH" "$installer" install --private-env-file "$private_env" --launch-agents-dir "$custom_launch_agents_dir"

if [ ! -f "$custom_launch_agents_dir/com.ai-agent-board.server.plist" ]; then
  printf 'FAIL: custom launch-agents-dir did not receive server plist\n'
  exit 1
fi

HOME="$tmp_home" PATH="$tool_bin:$PATH" "$installer" status --launch-agents-dir "$custom_launch_agents_dir" >/dev/null 2>&1
HOME="$tmp_home" PATH="$tool_bin:$PATH" "$installer" logs --launch-agents-dir "$custom_launch_agents_dir" server >/dev/null 2>&1
HOME="$tmp_home" PATH="$tool_bin:$PATH" "$installer" unload --launch-agents-dir "$custom_launch_agents_dir" >/dev/null 2>&1 || true
if [ -e "$custom_launch_agents_dir/com.ai-agent-board.server.plist" ]; then
  printf 'FAIL: unload did not target custom launch-agents-dir\n'
  exit 1
fi

HOME="$tmp_home" PATH="$tool_bin:$PATH" "$installer" install \
  --private-env-file "$special_private_env_file" \
  --repo-root "$special_repo_root" \
  --launch-agents-dir "$special_launch_agents_dir" \
  --logs-dir "$special_logs_dir"

printf 'plutil lint (special-char paths):\n'
for plist in "$special_launch_agents_dir"/*.plist; do
  plutil -lint "$plist"
done

python3 - "$special_launch_agents_dir" "$special_repo_root" "$special_private_env_file" "$special_logs_dir" <<'PY'
import plistlib
import sys
from pathlib import Path

launch_agents_dir, repo_root, private_env_file, logs_dir = sys.argv[1:]

expected = {
    'com.ai-agent-board.server.plist': ('server.out.log', 'server.err.log'),
    'com.ai-agent-board.client.plist': ('client.out.log', 'client.err.log'),
    'com.ai-agent-board.opencode.plist': ('opencode.out.log', 'opencode.err.log'),
}

for plist_name, (stdout_name, stderr_name) in expected.items():
    plist_path = Path(launch_agents_dir) / plist_name
    with plist_path.open('rb') as handle:
        payload = plistlib.load(handle)

    if payload['WorkingDirectory'] != repo_root:
        raise SystemExit(f'WorkingDirectory mismatch for {plist_name}: {payload["WorkingDirectory"]!r}')

    env = payload.get('EnvironmentVariables', {})
    private_env_value = env.get('AI_AGENT_BOARD_PRIVATE_ENV_FILE')
    if private_env_value != private_env_file:
        raise SystemExit(
            f'AI_AGENT_BOARD_PRIVATE_ENV_FILE mismatch for {plist_name}: {private_env_value!r}'
        )

    repo_env = env.get('AI_AGENT_BOARD_REPO_ROOT')
    if repo_env is not None and repo_env != repo_root:
        raise SystemExit(f'AI_AGENT_BOARD_REPO_ROOT mismatch for {plist_name}: {repo_env!r}')

    if payload['StandardOutPath'] != f'{logs_dir}/{stdout_name}':
        raise SystemExit(f'StandardOutPath mismatch for {plist_name}: {payload["StandardOutPath"]!r}')

    if payload['StandardErrorPath'] != f'{logs_dir}/{stderr_name}':
        raise SystemExit(f'StandardErrorPath mismatch for {plist_name}: {payload["StandardErrorPath"]!r}')
PY

expect_fail "vite client HOST=0.0.0.0" env PATH="$tool_bin:$PATH" HOME="$tmp_home" AI_AGENT_BOARD_REPO_ROOT="$repo_root" AI_AGENT_BOARD_PRIVATE_ENV_FILE="$bad_host_env" sh "$script_dir/wrappers/vite-client.sh"
expect_fail "board server HOST=0.0.0.0" env PATH="$tool_bin:$PATH" HOME="$tmp_home" AI_AGENT_BOARD_REPO_ROOT="$repo_root" AI_AGENT_BOARD_PRIVATE_ENV_FILE="$bad_host_env" sh "$script_dir/wrappers/board-server.sh"
expect_fail "vite client VITE_ALLOWED_HOSTS override" env PATH="$tool_bin:$PATH" HOME="$tmp_home" AI_AGENT_BOARD_REPO_ROOT="$repo_root" AI_AGENT_BOARD_PRIVATE_ENV_FILE="$bad_vite_hosts_env" sh "$script_dir/wrappers/vite-client.sh"
expect_ok "vite client loopback defaults" env PATH="$tool_bin:$PATH" HOME="$tmp_home" AI_AGENT_BOARD_REPO_ROOT="$repo_root" AI_AGENT_BOARD_PRIVATE_ENV_FILE="$private_env" sh "$script_dir/wrappers/vite-client.sh"

expect_ok "board server loopback defaults" env PATH="$tool_bin:$PATH" HOME="$tmp_home" AI_AGENT_BOARD_REPO_ROOT="$repo_root" AI_AGENT_BOARD_PRIVATE_ENV_FILE="$private_env" sh "$script_dir/wrappers/board-server.sh"

printf 'stale-state: overwriting a rendered plist\n'
printf 'junk\n' > "$tmp_home/Library/LaunchAgents/com.ai-agent-board.server.plist"
HOME="$tmp_home" PATH="$tool_bin:$PATH" "$installer" install --private-env-file "$private_env"

printf 'plutil lint:\n'
for plist in "$tmp_home"/Library/LaunchAgents/*.plist; do
  plutil -lint "$plist"
done

printf 'rendered files:\n'
printf '%s\n' "$tmp_home"/Library/LaunchAgents/*.plist

printf 'validation complete\n'
