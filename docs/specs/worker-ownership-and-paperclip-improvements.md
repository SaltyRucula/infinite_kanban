# Spec: Individual-Owned Workers + Paperclip-Inspired Improvements

Status: Draft for review
Author: orchestrator (grounded in current code + oracle review)
North star: **Individuals register and run their own workers.** The board delegates tasks; the operator's own machine, credentials, and sandbox are authoritative.

---

## 0. Context & the core reframe

infinite_kanban already ships the *skeleton* Paperclip formalizes: `POST /workers/register`, a heartbeat/lease/claim protocol under `/workers/me/*`, and `Task.assignedWorkerId`. Paperclip's slogan — "if it can receive a heartbeat, it's hired" — is effectively already our remote-worker protocol.

Two facts drive this spec:

1. **The trust inversion is already correct and must be protected.** `WorkerTaskAssignment` (shared/types.ts:79-103) deliberately carries **no `repoPath`**. The worker resolves its own workspace locally and scrubs paths out of summaries/errors. The server *cannot* aim a worker at a filesystem path. This is exactly what "individuals run their own workers" requires. **Do not regress it.**

2. **The ownership gap is at *assignment*, not registration.** `PATCH /tasks/:id` accepts `assignedWorkerId` for any worker id, and `GET /workers` (workers.ts:468) is unscoped. Adding an owner field to registration alone fixes nothing: today any board user can push arbitrary prompt text onto a stranger's laptop where it runs as code with that stranger's credentials.

---

## 1. Goals / Non-goals

### Goals
- Attribute each worker to a registering principal (`ownerId`) without introducing full user accounts.
- Let individuals enroll workers without holding a broad `workers:register` service token (enrollment codes).
- Gate task→worker assignment on **worker-declared consent** (opt-in project/label scope).
- Fix latent token-lifecycle and event-ingress **defects** that become dangerous once untrusted individuals participate.
- Optional early wins: project goal/context injection; cost telemetry.

### Non-goals (explicit — resist scope creep)
- ❌ **Org chart / roles / reporting lines / permissions matrix.** That is Paperclip's *company* thesis, contradicts "individuals run their own workers," and is dead weight on a task board.
- ❌ **Server-side scoped secret injection.** The board must never store or forward credentials to untrusted machines. The worker already holds its own creds locally — that's the entire point. **Hard non-goal.**
- ❌ **Budgets with hard stops + atomic checkout ledgers.** Unenforceable in our model (the individual pays their own bill on their own machine) and a distributed-transaction trap. Downgrade to observe-and-warn telemetry only.
- ❌ **New BYOA adapter plugins / webhook adapters.** The `/workers/me/*` protocol *is* the BYOA seam — anyone can implement it in any language today. Version and document it instead of multiplying RCE surface.
- ❌ **Short-lived run JWTs.** Already solved: the per-task `claimToken` (workers.ts:229-237) is the lease-bounded run credential. Do not add JWTs.
- ❌ Rebuilding the heartbeat into a coalesced wakeup queue. The 15s heartbeat / 5s poll is fine.

---

## 2. Identity model (minimal, no user accounts)

### 2a. Principal derived from existing auth
Resolve `req.principal = { id: string, kind: 'service' | 'legacy-admin' | 'enrollment' }` in the existing auth middleware. No new subsystem, no storage:
- `SERVICE_TOKENS`: add an `id` field to each credential's JSON → deterministic principal id.
- Legacy `API_KEY`: principal = single `legacy-admin`. Single-tenant behavior unchanged.

### 2b. `Worker.ownerId`
Add `ownerId: string` to `Worker` (shared/types.ts:22-33) and `WorkerRegistration` (worker-types.ts), set at register time from `req.principal.id`.

**Honest scope:** with no per-user *board* auth, `ownerId` is **attribution + blast-radius control + a revocation target**, not confidentiality against another board user. It becomes a real confidentiality boundary the day board user-auth lands — and the data model won't change then. Ship `ownerId` now, auth later, **no migration**. Do not oversell it in UI copy.

### 2c. Enrollment codes (for individuals without a service token)
- `POST /workers/enrollment-codes` (requires a scoped token) → returns a single-use code, TTL ≤ 15 min, stored **hashed**, bound to `ownerId` (+ optional `projectId`).
- `POST /workers/register` accepts `{ enrollmentCode }` **in place of** a bearer token; consumes it via consume-once CAS; derives `ownerId` from the code.
- One table, one TTL, one atomic consume.

### 2d. **Close the open-registration fallback** (defect)
With no `API_KEY` and no `SERVICE_TOKENS`, `auth.ts:75` falls through (`serviceCredentials.length === 0 → next()`), so **anyone can register a worker and poll `/me/assignments`**. Fine on loopback, catastrophic if exposed. **Registration must always require a credential** (enrollment code or scoped token). No fallback for the worker-registration path.

---

## 3. Consent-gated assignment (the real protection)

This is enforceable **today, with zero board auth**, because it validates against data the worker itself supplied — so it protects the operator even before `ownerId` means anything.

- Worker declares accepted scope at register/heartbeat: `acceptedProjectIds?: string[]` and/or `acceptedLabels?: string[]`.
- Assignment path (`PATCH /tasks/:id` @ tasks.ts:202-250, and `POST /run`): **reject `assignedWorkerId`** when the worker has not opted into the task's `projectId` (and, if used, labels).
- Rank this **above `ownerId`** in value: it is the mechanism that stops a stranger's prompt landing on your machine.

---

## 4. Phase 0 — Defect fixes (MUST precede any feature)

Everything else multiplies the blast radius of these. Ship first.

### 4a. Worker token lifecycle (currently unrevocable)
`WorkerRepository` (worker-types.ts) has **no `delete`, no `setStatus`, no `rotate`.** `WorkerStatus` includes `'disabled'` and `workerAuth` rejects it (worker-auth.ts:22) — **but nothing can ever set it.** A leaked worker token cannot be revoked without DB surgery. Add:
- `DELETE /workers/:id` (owner- or admin-scoped).
- Disable/enable → `setStatus('disabled' | 'online' | 'offline')`.
- `POST /workers/me/rotate` → new token, old hash invalidated.
- Max token age → forced re-enrollment.

### 4b. Harden worker→board event ingress
`POST /me/tasks/:id/events` (workers.ts:302-338) validates only `typeof`, then broadcasts to every client. Currently:
- `type` is **not** checked against `AgentEventType`.
- `content` has **no length cap**.
- `metadata` is **unvalidated**.
- `event.id` is **worker-chosen** (collision/overwrite risk).

Mandate: **server-generated `id`**, enum-validated `type`, `content` length cap (reuse `MAX_*` limits), `metadata` allowlist, and a per-worker rate limit.

### 4c. Scope / trim `GET /workers`
Unscoped listing (workers.ts:468) returns every worker's `name`/`hostname`/`version` → host fingerprinting of personal machines. Filter by `ownerId` (admin sees all); **drop `hostname`** from the public projection.

---

## 5. Later phases (value-ranked, additive)

### Phase 3 — Project goal/context injection (zero deps, early win)
Add `Project.goal? / context?`; inject into the `WorkerTaskAssignment` so the agent sees the "why." **Stop at two levels (task→project).** "Company goal ancestry" is org creep.
> Guard: inject **text context only**. Never ship skill *content* or paths — that's an executable payload to someone else's machine. `skills[]` may be **names** the worker resolves locally.

### Phase 4 — Cost telemetry (observe-and-warn, no ledger)
Read-only cost/token aggregation by worker/project/task, arriving via the (now-hardened) event stream. Needs `ownerId` (attribution) + Phase 0b. **No reservations, no hard stops, no atomic checkout.**

### Phase 5 — Widen `AgentType` (mechanical)
`AgentType = 'opencode'` today. Widening touches `isValidAgentType`, `Worker.agentTypes`, project defaults, templates, client `agent-config.ts`. Do it **before or after** ownership work, **never during**.

---

## 6. Security musts (spec-level contract)

| # | Requirement |
|---|-------------|
| a | **Consent-gated assignment** — reject `assignedWorkerId` for a project the worker didn't opt into (§3). |
| b | **No filesystem paths to workers, ever** — add a contract test asserting the exact key set of `WorkerTaskAssignment`; it's one convenience PR away from someone adding `repoPath`. |
| c | **No secrets to workers, ever** — stated non-goal, enforced by review. |
| d | **Named threat: prompt-injection→RCE on the operator's laptop.** Task text becomes a prompt on a stranger's machine. Mitigations are worker-side (its own sandbox/permission config is authoritative; it picks its workspace; it refuses unopted projects). The server can only avoid making it worse. |
| e | **Revocable tokens** (§4a). |
| f | **Untrusted event ingress hardening** (§4b). |
| g | **Owner-scoped, trimmed `GET /workers`** (§4c). |
| h | **Bridge URL** (`normalizeLoopbackBridgeUrl`, workers.ts:39-62) is well-built; expose stored `baseUrl` to the **owner only**, and never let the **server** fetch it — it's only meaningful on the worker's own machine. |
| i | **No open-registration fallback** (§2d). |

---

## 7. The one architectural fork to decide now

`assignedWorkerId` is a hard **1:1 pin**. Paperclip's model is a **pool**. For a many-individuals board, capability-matched pooling is strictly better and the machinery mostly exists: `getWorkerAssignments(workerId)` generalizes to `getEligibleTasks(capabilities)`, and `claimWorkerTask` already does the atomic CAS that makes contention safe.

**Recommendation:** keep pin as the default; add pool as opt-in per-project *later* — but design `ownerId` and opt-in scope (§2b, §3) **now** so pool mode becomes a query change, not a re-modeling. This is the single Phase-1 decision where getting the data model wrong is expensive.

---

## 8. Ordering / dependencies

```
Phase 0  Defects: revoke/disable/delete + event-ingress hardening + close open-registration
           │  (blocks everything — reduces blast radius first)
Phase 1  Principal + ownerId + enrollment codes + owner-filtered listing
           │  (gates Phase 2 and Phase 4)
Phase 2  Worker opt-in scope + assignment validation (tasks.ts:202)
           │  (independent of P1 technically, but pointless UX without it)
Phase 3  Project goal/context in assignment      ← zero-dep early win, do anytime
Phase 4  Cost telemetry                          ← needs P1 + P0b
Phase 5  Widen AgentType                          ← mechanical, never during ownership work
```

---

## 9. Paperclip concept disposition (summary table)

| Paperclip concept | Verdict | Why |
|---|---|---|
| "Heartbeat = hired" BYOA | **Already have it** | `/workers/me/*` is the seam; version+document, don't build adapters |
| Short-lived run JWT | **Already have it** | per-task `claimToken` is the lease-bound run credential |
| Worker opt-in / consent | **Do (top priority)** | the real protection, enforceable today |
| ownerId + enrollment codes | **Do** | attribution + revocation target |
| Revoke/disable/rotate | **Do (defect fix)** | currently impossible |
| Orphaned-run recovery | **Mostly have it** | lease expiry + stale sweep; close gaps only |
| Goal ancestry (2 levels) | **Maybe (early win)** | task→project only |
| Skills (names only) | **Maybe** | never ship skill content |
| Cost tracking | **Maybe (observe/warn)** | no ledger |
| Org chart / roles / budgets-hardstop | **No — trap** | org thesis, unenforceable, distributed-txn |
| Server-side secret injection | **No — worst trap** | forwards creds to untrusted machines |
| Webhook/adapter plugins | **No (for now)** | multiplies RCE surface, ~0 value while single-provider |
