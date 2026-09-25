# Deployment

This page covers running Infinite Kanban as a long-lived service. For a local development setup, see [Development](development.md). Every environment variable mentioned here is defined in [Configuration](configuration.md).

A deployment has three parts:

- **Server** (`packages/server`): Express API, WebSocket, and database access. Listens on `8080`.
- **Client** (`packages/client`): the React board, served by Vite on `8081` or as static files behind nginx.
- **Workers** (`packages/worker`): run agent tasks on machines that hold your repositories. See [Workers](workers.md).

Use **PostgreSQL** (`DATABASE_URL`) for any shared deployment. SQLite is the zero-config default for single-user local use.

## Build

```bash
npm install
npm run build:server   # packages/server/dist
npm run build:client   # packages/client/dist
npm run worker:build   # packages/worker/dist
```

## Option 1: single host with systemd, nginx, and Cloudflare

This is the reference production layout.

| Component | Where | Binding |
|-----------|-------|---------|
| `kanban-server.service` | `/etc/systemd/system/kanban-server.service` | `127.0.0.1:8080` |
| `kanban-client.service` | `/etc/systemd/system/kanban-client.service` | `127.0.0.1:8081` |
| nginx Kanban ingress | `/etc/nginx/sites-enabled/kanban` | `127.0.0.1:18085` |
| PostgreSQL | `ai-agent-board-db` Docker container (`postgres:16-alpine`) | host port `5433` |

- **Cloudflare Tunnel** is the only ingress path and targets the nginx ingress.
- **Cloudflare Access** is the user-authentication boundary.
- Keep the server, client, and nginx ingress bound to loopback. Do not bind them to public or Tailscale interfaces.
- The server reads `packages/server/.env`. Set `DATABASE_URL` to the Postgres container; do not fall back to SQLite in production.
- Add the public hostname to `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`, and `VITE_ALLOWED_HOSTS`, and set `AGENT_BOARD_PUBLIC_URL` so orchestration deep links use it.

Start the database with the root [`docker-compose.yml`](../docker-compose.yml) (change `POSTGRES_PASSWORD` first):

```bash
docker compose up -d
# packages/server/.env
DATABASE_URL=postgresql://agentboard:<password>@localhost:5433/agentboard
```

Operate the services with systemd:

```bash
systemctl status kanban-server kanban-client
systemctl restart kanban-server kanban-client   # after code changes
journalctl -u kanban-server -f
journalctl -u kanban-client -f
```

## Option 2: Docker Compose stack

[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) builds and runs the whole board on one Docker host:

| Service | Image | Notes |
|---------|-------|-------|
| `db` | `postgres:16-alpine` | Health-checked; data in the `pgdata` volume |
| `server` | `deploy/Dockerfile.server` | Binds `0.0.0.0:8080` inside the network only; data and clone root in the `serverdata` volume (`AGENTBOARD_HOME=/data/agentboard`) |
| `web` | `deploy/Dockerfile.web` | nginx serving the built client and proxying `/api` and `/ws` to `server`; published on host port `80` |
| `worker` | `deploy/Dockerfile.worker` | Optional, behind the `worker` profile; see [Workers › Docker](workers.md#docker) |

```bash
cd deploy
cp .env.example .env   # set POSTGRES_PASSWORD, ALLOWED_HOSTS, ALLOWED_ORIGINS
docker compose --env-file .env up -d --build
```

The stack leaves `API_KEY` unset, so the board is open to anyone who can reach port 80. Run it only on a private network or behind your own access layer. Use `SERVICE_TOKENS` to protect the orchestration, Jira, and worker-registration routes.

## Option 3: macOS login services (launchd)

[`scripts/launchd/`](../scripts/launchd/) ships templates and wrappers that run the server, the Vite client, and a dedicated OpenCode server as per-user LaunchAgents:

```bash
scripts/launchd/manage-launchd.sh install --private-env-file "$HOME/.config/ai-agent-board/private.env"
scripts/launchd/manage-launchd.sh status    # [all|server|client|opencode]
scripts/launchd/manage-launchd.sh logs
scripts/launchd/manage-launchd.sh unload
```

- The private env file must exist outside the repository, be owned by you, and have no group or world access.
- The OpenCode service listens on `127.0.0.1:4098`, so point the server at it with `OPENCODE_BASE_URL=http://127.0.0.1:4098`. Port 4096 is avoided on purpose: it is the OpenCode CLI's default and may already be used by an interactive session.
- `OPENCODE_BASE_URL` must follow the loopback rules in [Configuration](configuration.md#agent-execution). The client wrapper rejects public `HOST` or `VITE_ALLOWED_HOSTS` values.
- After `install`, start the services with the `launchctl bootstrap gui/$(id -u) …` commands it prints.

## Security checklist

- Keep `HOST=127.0.0.1` unless another layer controls access.
- Set `API_KEY` (and a matching `VITE_API_KEY`) or put the board behind an authenticating proxy such as Cloudflare Access.
- Give integrations service tokens with the narrowest scopes, stored as SHA-256 digests.
- Restrict `ALLOWED_REPO_ROOTS` to the directories agents may modify.
- Never use a wildcard in `ALLOWED_HOSTS` or `VITE_ALLOWED_HOSTS`.

See also [SECURITY.md](../SECURITY.md).
