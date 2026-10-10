---
name: "infinite-kanban-repo"
description: "Repo-specific conventions for infinite_kanban: git identity/SSH setup, local dev, required gate, and deployment target"
domain: "project-conventions"
confidence: "high"
source: "team-decision"
---

## What this repo is

Agentic AI Kanban Board (`ai-agent-board` monorepo, npm workspaces). See root `AGENTS.md` for full architecture (client/server/e2e packages, shared types, agent providers).

## Deployment

- Live instance: **http://10.190.52.128/** — Docker Compose, not systemd. The `kanban-server`/`kanban-client` systemd units in `AGENTS.md` describe a different (codewithdan) host.
- Host layout: app clone `/root/apps/infinite_kanban`, compose project dir `deploy/` (`project=deploy`), containers `ai-agent-board-web` (nginx, publishes :80), `ai-agent-board-server` (internal :8080), `ai-agent-board-db` (postgres:16-alpine). Secrets in `deploy/.env` (untracked); `API_KEY`/`SERVICE_TOKENS` are unset, so the board — including `/a2a/v1` — is open on the private network.
- Git path: the host clone's `origin` is a **local bare repo** `/root/repos/infinite_kanban.git`, and the local clone has a `deploy` remote pointing at it. Deploy procedure:

  ```bash
  git push deploy main                                  # from the local clone
  ssh root@10.190.52.128 'cd /root/apps/infinite_kanban && git pull --ff-only'
  ssh root@10.190.52.128 'cd /root/apps/infinite_kanban/deploy && \
    docker compose --env-file .env up -d --build server web'
  ```

  The image build takes ~8-10 minutes on that host (loaded box, native `better-sqlite3` build, slow layer export) — run it in the background, not a foreground call.
- Verify after deploy: `curl http://10.190.52.128/.well-known/agent-card.json`, a `SendMessage` JSON-RPC call to `/a2a/v1`, `GET /` still serving the SPA, and `docker logs --tail ai-agent-board-server`.
- Adding a new workspace package means editing **both** `deploy/Dockerfile.server` and `deploy/Dockerfile.web`: every workspace `package.json` must be copied before `npm ci`, and the server image must build the new package.
- New server HTTP paths outside `/api` and `/ws` need an explicit `location` in `deploy/nginx.conf`, or the SPA history fallback swallows them and returns `index.html`.

## Production (other host)

- Live instance: **http://10.190.52.128/**
- Production also runs via systemd on `kanban.codewithdan.com` (see `AGENTS.md` → Production (systemd)):
  - `kanban-server` (port 8080, Express API + WS + agent SDKs)
  - `kanban-client` (port 8081, Vite dev server behind nginx)
  - Restart after code changes: `systemctl restart kanban-server kanban-client`
  - Logs: `journalctl -u kanban-server -f` / `-u kanban-client -f`
  - Production uses PostgreSQL (`ai-agent-board-db` container, port 5433) — never falls back to SQLite in prod.

## Git identity for this repo

This repo's GitHub remote is the **`SaltyRucula`** account, authenticated via a dedicated SSH key — separate from any other GitHub identity on this machine.

**Local git identity (already configured):**
```bash
git config user.name saltyrucula
git config user.email jose.martins709@icloud.com
```

**SSH setup (already configured on this machine):**
- Dedicated key: `~/.ssh/saltyrucula` / `~/.ssh/saltyrucula.pub`
- `~/.ssh/config` host alias:
  ```
  Host github.com-saltyrucula
    HostName github.com
    User git
    IdentityFile ~/.ssh/saltyrucula
    IdentitiesOnly yes
  ```
- Remote uses the alias host, not `github.com` directly:
  ```bash
  git remote -v
  # origin  git@github.com-saltyrucula:SaltyRucula/infinite_kanban.git
  ```

**Verify auth identity before pushing from a new clone/machine:**
```bash
ssh -T git@github.com-saltyrucula
# expect: "Hi SaltyRucula! You've successfully authenticated..."
```

If cloning fresh elsewhere, set the remote URL to the aliased host (not plain `github.com`) so pushes authenticate as `SaltyRucula`:
```bash
git remote set-url origin git@github.com-saltyrucula:SaltyRucula/infinite_kanban.git
```

## Local dev

```bash
npm install
npm run dev:server   # port 8080
npm run dev:client   # port 8081
```

## This machine's environment traps

- `npm config get omit` is **dev**, so a plain `npm install` skips devDependencies and `tsx` is missing → every `node --import tsx/esm --test` script fails with `ERR_MODULE_NOT_FOUND: tsx`. Run `npm install --include=dev` once per clone.
- `better-sqlite3` install scripts are not approved, so its native binding is unbuilt and DB-backed server tests die with `ERR_DLOPEN_FAILED`. Fix: `npm install-scripts approve better-sqlite3`, then `cd packages/server/node_modules/better-sqlite3 && npx node-gyp rebuild --release`.
- Git hooks are **not** installed in a fresh clone (`git config core.hooksPath` is empty), so `gate:required` does not run on push — CI (`build-and-test 22.x`) is the real gate. Run `npm run hooks:install` for the local gate.
- `gh` has two accounts and the active one is the BMW account, but this repo is **SaltyRucula**: `gh auth switch --user SaltyRucula` before creating issues/PRs, then switch back. Commit with `git -c user.name=saltyrucula -c user.email=jose.martins709@icloud.com`.

## Check `origin` before planning anything

This clone goes stale fast — work is merged on GitHub while local `main` sits behind. Always run `git fetch origin && git rev-list --left-right --count main...origin/main` and `gh pr list --state all --limit 20` before designing or implementing. A whole A2A foundation (agent directory, JSON-RPC executor, workflow gate, console UI; PRs #70–#73) existed on `origin/main` while local `main` showed no trace of it.

## Known baseline test state

Root `npm run test` runs **e2e only**; server unit tests sit outside `gate:required` (client build + server build + e2e). As of `661b98e`, `packages/server` has **48 pre-existing unit-test failures** (worker review settlement, worker token lifecycle, `request_work` ingress). Compare before/after counts instead of assuming a red suite is your fault.

## A2A work

- Product plan: `docs/proposals/a2a-first-rework.md` (waves 0–4; 0–2 merged).
- Protocol/mapping companion: `docs/specs/a2a-protocol-adoption.md`; tracking issues #74–#80.
- Target is A2A **v1.0**: PascalCase JSON-RPC methods (`SendMessage`, `GetTask`, `CancelTask`), flattened parts (`{"text": ...}`), `role: ROLE_USER`, and the `A2A-Version` header (an absent header makes the peer assume 0.3). v0.3 uses `message/send` and `{kind:'text'}` — never mix the dialects.

## Required gate before pushing / opening PRs

```bash
npm run gate:required   # client build + server build + required E2E
```

The committed `.githooks/pre-push` hook runs this automatically — don't bypass it. Enable it per clone:
```bash
npm run hooks:install
```

## Squad conventions

Check `.squad/team.md`, `.squad/routing.md`, `.squad/coverage-matrix.md`, and `.copilot/skills/` / `.squad/skills/` before non-trivial work — this repo runs in "squad" operating mode (see `AGENTS.md` → Squad Operating Mode).
