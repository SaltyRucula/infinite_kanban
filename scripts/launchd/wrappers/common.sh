#!/bin/sh

aiab_error() {
  printf '%s\n' "$*" >&2
  exit 1
}

aiab_validate_private_env_file() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
st = os.stat(path)

if st.st_uid != os.getuid():
    raise SystemExit(f'Private env file must be owned by the current user: {path}')

if st.st_mode & 0o077:
    mode = stat.S_IMODE(st.st_mode)
    raise SystemExit(f'Private env file must not be group- or world-accessible ({mode:04o}): {path}')
PY
}

aiab_validate_loopback_http_url() {
  python3 - "$1" <<'PY'
from urllib.parse import urlparse
import sys

url = sys.argv[1]
authority = url.split('://', 1)[1].split('/', 1)[0] if '://' in url else ''
parts = urlparse(url)

if parts.scheme != 'http':
    raise SystemExit(f'OPENCODE_BASE_URL must use http: {url}')

if '@' in authority:
    raise SystemExit(f'OPENCODE_BASE_URL must not include userinfo or @ in authority: {url}')

if parts.hostname not in {'localhost', '127.0.0.1', '::1'}:
    raise SystemExit(f'OPENCODE_BASE_URL must resolve to loopback: {url}')

try:
    port = parts.port
except ValueError as exc:
    raise SystemExit(f'OPENCODE_BASE_URL has an invalid port: {url}') from exc

if port is None:
    raise SystemExit(f'OPENCODE_BASE_URL must include an explicit port: {url}')

if parts.path not in {'', '/'} or parts.params or parts.query or parts.fragment:
    raise SystemExit(f'OPENCODE_BASE_URL must be an origin-only URL: {url}')
PY
}

aiab_validate_loopback_host() {
  case "$1" in
    localhost|127.0.0.1|::1)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

aiab_validate_loopback_host_list() {
  python3 - "$1" <<'PY'
import sys

hosts = [host.strip().lower() for host in sys.argv[1].split(',') if host.strip()]
if not hosts:
    raise SystemExit('VITE_ALLOWED_HOSTS must not be empty')

allowed = {'localhost', '127.0.0.1', '::1'}
for host in hosts:
    if host not in allowed:
        raise SystemExit(f'VITE_ALLOWED_HOSTS must be loopback-only: {sys.argv[1]}')
PY
}

aiab_load_private_env_file() {
  env_file=$1

  [ -f "$env_file" ] || aiab_error "Missing private env file: $env_file"
  aiab_validate_private_env_file "$env_file"

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*)
        continue
        ;;
      export\ *)
        line=${line#export }
        ;;
    esac

    case "$line" in
      *'='*)
        key=${line%%=*}
        value=${line#*=}

        case "$key" in
          ''|*[!A-Za-z0-9_]*|[0-9]*)
            aiab_error "Unsupported env key in $env_file: $key"
            ;;
        esac

        case "$value" in
          \"*\")
            value=${value#\"}
            value=${value%\"}
            ;;
          \'*\')
            value=${value#\'}
            value=${value%\'}
            ;;
        esac

        export "$key=$value"
        ;;
      *)
        aiab_error "Unsupported env line in $env_file: $line"
        ;;
    esac
  done < "$env_file"
}
