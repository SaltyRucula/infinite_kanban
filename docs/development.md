# Development

How to work on Infinite Kanban locally and what must pass before you push. Setup prerequisites and the first run are in the [README](../README.md#quick-start).

## Repository layout

npm workspaces:

| Workspace | Package | Purpose |
|-----------|---------|---------|
| `packages/client` | `@ai-agent-board/client` | React 19 + Vite + Tailwind 4 board UI |
| `packages/server` | `@ai-agent-board/server` | Express API, WebSocket, repositories, agent orchestration |
| `packages/worker` | `@ai-agent-board/worker` | Worker CLI that runs agent tasks on a local machine |
| `packages/e2e` | `@ai-agent-board/e2e` | Playwright end-to-end tests |
| `shared` | `@ai-agent-board/shared` | Types and validation shared by client, server, and worker |

See [Architecture](architecture.md) for how the pieces fit together.

## Day-to-day commands

```bash
npm run dev            # build shared, then server + client together
npm run dev:server     # API only, http://127.0.0.1:8080 (tsx watch)
npm run dev:client     # Vite only, http://127.0.0.1:8081 (proxies /api and /ws to the server)
npm run worker:dev     # worker CLI in watch mode (needs prior registration, see workers.md)
```

When you change anything in `shared/`, run `npm run build:shared` (or restart `npm run dev`) so the other workspaces pick it up.

To run tasks locally you also need a worker: register one against `http://localhost:8080` as described in [Workers](workers.md).

## Tests

| Command | What it runs |
|---------|--------------|
| `npm run gate:required` | **Required before push.** Client build, server build, and the required E2E suite. Fails if E2E cannot run. |
| `npm run test:e2e:required` | Playwright E2E suite only (`npm test` is an alias) |
| `npm test -w @ai-agent-board/server` | Server unit tests (`node --test`) |
| `npm run worker:test` | Worker unit tests (`node --test`) |

### E2E

Playwright starts its own isolated server and client on ports `3002` and `4176` (override with `E2E_SERVER_PORT` / `E2E_CLIENT_PORT`), so it does not collide with a running dev setup. Install the browser once with `npx playwright install chromium`.

```bash
npm run test:e2e:required
cd packages/e2e && npx playwright test tests/board.spec.ts --reporter=list   # one file
npm run test:ui -w @ai-agent-board/e2e                                        # Playwright UI mode
```

Specs live in [`packages/e2e/tests`](../packages/e2e/tests) and cover the board, task groups, templates, projects, archiving, clarification flows, Jira import and automation, git operations, and agent selection. Specs that need a real agent (`agent-sdk.spec.ts`, `group-integration.spec.ts`) skip when one is not available.

Portability or setup problems are blockers to fix, not reasons to skip affected E2E coverage.

### Pre-push hook

The committed [`.githooks/pre-push`](../.githooks/pre-push) hook runs `npm run gate:required`. Enable it once per clone:

```bash
npm run hooks:install   # sets core.hooksPath to .githooks
```

CI runs the same gate on Node 22 (`.github/workflows/ci.yml`).

## Code conventions

- TypeScript `strict` everywhere; shared types and validators (`VALID_TRANSITIONS`, `isValidPriority`, length limits) live in `shared/`.
- Server data access goes through the repository interfaces, with SQLite and PostgreSQL implementations kept in sync.
- Follow existing patterns rather than introducing new ones. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the pull-request process.
