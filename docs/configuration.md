# Configuration

This is the authoritative reference for Infinite Kanban's environment variables. Other documents link here instead of repeating defaults.

- **Server** variables are read from `packages/server/.env` (via dotenv) or the process environment. Start from [`packages/server/.env.example`](../packages/server/.env.example).
- **Client** variables are read by Vite from `packages/client/.env` or the process environment.
- **Worker** variables are read from the worker process environment. Worker credentials are stored separately in `~/.agentboard-worker/` (see [Workers](workers.md)).

## Server

### Network and access

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | API + WebSocket port. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback when the app sits behind a local reverse proxy or Cloudflare Tunnel; a non-loopback bind needs its own security boundary. |
| `ALLOWED_ORIGINS` | `http://localhost:8081,http://localhost:4175,http://localhost:4176` | Comma-separated CORS and WebSocket `Origin` allowlist. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated `Host` allowlist for WebSocket upgrades. Add the trusted reverse-proxy hostname in production. |
| `API_KEY` | _(unset)_ | Full-access Bearer token for every API route and the WebSocket. Unset = open access. Must match the client's `VITE_API_KEY`. |
| `SERVICE_TOKENS` | _(unset)_ | JSON array of scoped integration credentials. See [Service tokens](#service-tokens). |
| `AGENT_BOARD_PUBLIC_URL` | _(request origin)_ | Public base URL used to build task deep links returned by the orchestration API, e.g. `https://kanban.example.com`. |

### Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | _(unset)_ | PostgreSQL connection string. When unset the server uses SQLite. |
| `DB_PATH` | `./data/agentboard.db` | SQLite database file (relative to the server's working directory). Ignored when `DATABASE_URL` is set. |
| `AGENTBOARD_HOME` | `~/agentboard` | Directory for the server's persisted `config.json` and the default clone root (`<home>/projects`) for projects added from a Git URL. |

### Agent execution

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_TIMEOUT_MS` | `3600000` (60 min) | Default maximum run time. A task can override it with a time limit of 1–240 minutes. See [Architecture › Timeouts](architecture.md#timeouts-and-event-retention). |
| `OPENCODE_BASE_URL` | _(unset)_ | Connect server-side OpenCode sessions to an existing OpenCode server instead of spawning a managed one. Must be loopback (`localhost`, `127.0.0.1`, or `[::1]`) with an explicit port and no path, query, hash, or userinfo. |
| `OPENCODE_MODEL` | _(OpenCode default)_ | Model for server-side OpenCode sessions, as `provider/model`. |
| `ALLOWED_REPO_ROOTS` | home dir, temp dir, current workspace | Comma-separated allowlist of repository roots agents may work in. The configured clone root is always included. |
| `PROJECTS_DIR` | _(unset)_ | Extra root added to the default allowlist when `ALLOWED_REPO_ROOTS` is unset. |
| `AGENTBOARD_DISABLE_AGENT_STARTUP` | _(unset)_ | Set to `1`/`true` to skip agent detection at startup (used by tests). |

### Jira import

All Jira variables are server-only and never sent to the client or logs. Behaviour is described in [Integrations › Jira](integrations.md#jira-assigned-issue-import).

| Variable | Default | Description |
|----------|---------|-------------|
| `JIRA_BASE_URL` | _(unset)_ | Jira base URL, e.g. `https://jira.example.com`. |
| `JIRA_USER_EMAIL` | _(unset)_ | Jira user email (required for basic auth mode). |
| `JIRA_API_TOKEN` | _(unset)_ | Jira API token, used only in the `Authorization` header sent to Jira. |
| `JIRA_IS_DATACENTER` | `false` | `true` = `Bearer <token>` (Jira Data Center). Otherwise basic `email:token` (Jira Cloud). |

### Service tokens

`SERVICE_TOKENS` holds credentials for integrations that should not get full `API_KEY` access. Prefer storing the SHA-256 digest of the token instead of the token itself:

```bash
SERVICE_TOKENS='[{"sha256":"<sha256-of-token>","scopes":["projects:read","agents:read","orchestrations:create","orchestrations:read","orchestrations:message"]}]'
```

| Scope | Grants |
|-------|--------|
| `projects:read` | Accepted for forward compatibility; project reads are not scope-gated today |
| `agents:read` | `POST /api/agents/refresh` |
| `orchestrations:create` | `POST /api/orchestrations`, `POST /api/orchestrations/:id/retry` |
| `orchestrations:read` | `GET /api/orchestrations/:id` |
| `orchestrations:message` | `POST /api/orchestrations/:id/message` |
| `jira:import` | `/api/jira/*` |
| `workers:register` | `POST /api/workers/register` (worker bootstrap) |

Service tokens cannot merge, create PRs, delete resources, or mutate projects. When `API_KEY` is set, every route requires either the API key or a service token with the matching scope. When only `SERVICE_TOKENS` is set, the browser/API surface stays open (behind your outer access boundary) and only the scoped routes above require a token. Worker endpoints under `/api/workers/me/*` always authenticate with the worker's own token instead.

## Client (Vite)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_KEY` | _(unset)_ | API key the browser sends; must match `API_KEY`. Baked into the build. |
| `API_URL` | `http://localhost:8080` | Target for the Vite dev proxy (`/api`, `/ws`). |
| `HOST` | `127.0.0.1` | Vite dev-server bind address. |
| `VITE_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Vite HTTP and proxy-upgrade `Host` allowlist. Add trusted reverse-proxy hostnames; never use a wildcard. |

The Vite dev server always listens on port `8081`.

## Worker

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_WORKER_MODEL` | `github-copilot/claude-sonnet-5` | Model for the `opencode-server` runner, as `provider/model`. The default needs GitHub Copilot auth on the worker host. |
| `OPENCODE_BASE_URL` | _(unset)_ | For the `agent-sdk` runner: use an existing loopback OpenCode server (same rules as the server variable). |
| `OPENCODE_SESSION_BRIDGE_PORT` | random free port | Loopback port of the worker's session bridge, which lets the board open a task's live OpenCode session in the worker's local OpenCode UI. |

The Docker worker image has its own registration variables; see [Workers › Docker](workers.md#docker).
