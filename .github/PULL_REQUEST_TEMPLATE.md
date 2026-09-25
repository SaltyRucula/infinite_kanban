<!--
PR title: Conventional Commits, e.g. `fix(worker-lease): clear claim token on completion`
Types: feat, fix, refactor, perf, test, docs, chore, ci, build
-->

## Problem

<!-- What is broken or missing, and who notices? Link issues if any. -->

## Fix

<!-- What changed and why this approach. Call out anything that affects other clients (WebSocket payloads, API responses, DB schema). -->

## Verification

<!-- Commands run and their results. Note any pre-existing failures and confirm they reproduce without this diff. -->

- [ ] `npm run gate:required` (client build, server build, E2E)
- [ ] `npm test -w @ai-agent-board/server`
- [ ] `npm test -w @ai-agent-board/worker`
