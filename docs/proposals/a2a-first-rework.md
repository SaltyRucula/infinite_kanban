# A2A-first workflow rework

**Status:** proposed foundation  
**Date:** October 7, 2026  
**Scope:** `infinite_kanban`

## Problem statement

Infinite Kanban currently combines a task board with a bespoke remote-worker control plane. The worker path owns registration, enrollment codes, worker tokens, heartbeats, offline detection, task assignment, claims, renewable leases, command polling, event ingestion, and OpenCode session bridging. A separate in-process path executes orchestration and Jira tasks through `AgentManager`.

That makes the core product flow indirect and difficult to reason about:

- Board-originated work must be manually assigned to a worker before it can run.
- A task can execute by two different transports with different recovery and lifecycle rules.
- The board records completion but does not own a durable implementation → independent review → rework loop.
- The transport is specific to this repository's worker CLI rather than an interoperable agent protocol.
- Existing production assumptions reference CodeWithDan-hosted infrastructure and are not part of the intended personal/local-first product.

The desired product is narrower: a user creates or receives a ticket, the board sends it to an implementation-capable agent, sends the resulting artifact to a distinct reviewer, and repeats the implementation/review cycle until the reviewer approves or the board escalates to a human.

## Proposed architecture

Infinite Kanban becomes a **workflow coordinator and audit trail**. A2A-capable agents are execution endpoints.

```text
Ticket ingress
  └─ Board ticket and durable workflow state
       └─ Dispatcher
            ├─ selects implementation agent
            ├─ sends A2A task
            ├─ records task updates and artifact references
            ├─ selects a distinct reviewer
            └─ repeats rework or closes the ticket

Trusted A2A agent directory
  └─ configured Agent Card URLs, cached capabilities, project policy
```

### Responsibilities

| Component | Owns | Does not own |
|---|---|---|
| Board | tickets, workflow state, routing policy, review rounds, audit history, escalation | agent-specific SDK details or machine-local process control |
| A2A adapter | Agent Card validation, protocol requests, task correlation, update/artifact mapping | board workflow decisions |
| A2A agent | implementation or review work, progress updates, artifacts, questions, terminal result | canonical board state or routing policy |
| Agent directory | trusted agent endpoints and their allowed projects/capabilities | unbounded public-agent search or credentials embedded in cards |

### Minimum workflow state

The first implementation uses explicit phases rather than inferring workflow from a task's column alone:

```text
backlog
  → implementing
  → awaiting_review
  → reviewing
  → done

reviewing + changes_requested
  → implementing

any active phase + terminal dispatch failure / round limit
  → needs_human_decision
```

A workflow run records at least:

- its role: `implementation` or `review`
- board ticket ID and A2A task ID
- assigned agent ID and Agent Card URL
- status and timestamps
- artifact references: branch, commit, pull request, patch, or external URI
- parent implementation run for review runs
- review verdict and feedback for review runs

### Routing policy v1

1. A Backlog ticket is dispatched to an enabled implementation agent permitted for the ticket project.
2. A completed implementation with at least one usable artifact is dispatched to an enabled review agent permitted for the project.
3. The reviewer must not have the same agent identity as the latest implementation run.
4. An approval closes the ticket.
5. A `changes_requested` verdict produces a new implementation run with the reviewer feedback and artifact references in its task context.
6. The default maximum is three review rounds. The fourth requested-change outcome moves the ticket to `needs_human_decision` rather than looping indefinitely.
7. Missing eligible agents, invalid artifacts, A2A transport failures, and ambiguous terminal responses also move the ticket to `needs_human_decision` with a visible reason.

### Agent discovery v1

Discovery is a local, curated directory:

1. A user adds an Agent Card URL.
2. The board fetches and validates the card.
3. The board stores a normalized registration and cached advertised capabilities.
4. The user grants project access and declares which workflow roles the agent may perform.

This deliberately excludes public crawling, reputation, autonomous trust decisions, and a global registry. Those are future product decisions, not prerequisites for the core workflow.

### A2A boundary

The board needs one generic interface. It must be feasible to test without a live remote agent:

```ts
interface A2AExecutor {
  dispatch(input: DispatchInput): Promise<DispatchReceipt>;
  getUpdate(remoteTaskId: string): Promise<RemoteTaskUpdate>;
  cancel(remoteTaskId: string): Promise<void>;
}
```

The adapter converts A2A protocol states, messages, artifacts, and input-required signals into the board's neutral execution events. The workflow engine consumes only those neutral events; it must not depend on OpenCode, a local process, HTTP polling details, or a particular agent SDK.

## What changes

### Wave 0 — workflow foundation

- Add explicit workflow/run domain types and a pure routing policy.
- Add deterministic tests for approval, change request, reviewer separation, exhaustion, and dispatch failure.
- Preserve current task cards while exposing workflow phase/history as additive data.

### Wave 1 — trusted A2A agent directory

- Add configured Agent Card registrations, validation, project policy, and UI.
- Add SQLite/PostgreSQL persistence and API routes.
- Do not perform execution migration in this wave.

### Wave 2 — A2A execution adapter

- Implement dispatch, task update ingestion/polling, input requests, cancellation, and artifact mapping.
- Dispatch one implementation → review → rework tracer workflow against test A2A endpoints.

### Wave 3 — cut over board execution

- Route new board tickets through the workflow dispatcher.
- Add a migration/read-only compatibility strategy for existing worker-backed tasks.
- Remove manual worker assignment from the primary task workflow.

### Wave 4 — retire legacy execution fabric

- Remove worker enrollment, token rotation, heartbeat/lease claims, command polling, worker session bridge, and worker-specific UI.
- Remove obsolete CodeWithDan deployment and integration documentation from the core product documentation.
- Keep integrations only when rebuilt as ticket-ingress adapters or A2A-compatible clients.

## What stays the same

- React board UI, project and task persistence, WebSocket updates, event timeline, and task history.
- Repository and artifact safety controls.
- Task review as an explicit quality gate before Done.
- SQLite and PostgreSQL support unless a later data-model decision changes it.
- Existing worker flow during the migration; no destructive data migration is part of the first wave.

## Key decisions

### 1. Board-coordinated workflow, not agent-led delegation

**Recommendation:** The board selects the next agent and records every handoff.

Allowing agents to delegate without board mediation would hide work, artifacts, costs, and review outcomes from the canonical ticket history. Agents may perform internal sub-work, but the board remains responsible for ticket-level dispatch and closure.

### 2. Curated Agent Cards, not public discovery

**Recommendation:** Start with user-configured, trusted Agent Card URLs.

A public registry adds identity, authorization, availability, and abuse policy before the core workflow works. The directory must first solve trusted local/project routing.

### 3. Review requires a distinct agent identity

**Recommendation:** Prohibit self-approval in v1.

A reviewer can be the same product/provider family when necessary, but it must be a distinct configured agent registration. Any exception requires an explicit human override and audit event.

### 4. Artifacts are protocol-neutral

**Recommendation:** Exchange artifact references, not machine-local paths.

Remote agents must not require the board host to share a filesystem. The first common artifacts are branch/commit/PR URLs and patches. A task may later declare a repository-access strategy separately.

### 5. Explicit human escalation

**Recommendation:** Bound autonomous retries and review cycles.

A ticket must never silently loop. A missing agent, ambiguous result, validation failure, timeout, or exhausted review round moves it to a visible human-decision state.

## Risks and mitigations

### Risk: A2A agents are not reachable from the board host

**Likelihood:** Medium  
**Impact:** High

**Mitigation:** Treat reachability as an agent-registration health check. Define the first supported deployment topology before removing pull workers. If remote machines sit behind NAT, use an approved relay/tunnel or an A2A gateway; do not recreate a custom worker transport by accident.

### Risk: Agent Cards describe capabilities but do not guarantee repository access

**Likelihood:** High  
**Impact:** High

**Mitigation:** Route by explicit project policy and require implementation tasks to declare artifact expectations. Do not infer that an agent can access a local path because it advertises a coding skill.

### Risk: A2A task lifecycle does not map one-to-one to board review semantics

**Likelihood:** Medium  
**Impact:** Medium

**Mitigation:** Keep a board-owned normalized execution event model and an explicit review verdict contract. A raw remote terminal state never automatically means a ticket is approved.

### Risk: Parallel refactor breaks current worker workflows

**Likelihood:** Medium  
**Impact:** High

**Mitigation:** Introduce the workflow core as additive, feature-gate dispatch cutover, and retain current worker behavior until the A2A tracer path has deterministic coverage.

## Success criteria

The Wave 0–2 tracer is complete when a deterministic test can prove all of the following:

1. A new ticket selects an eligible implementation agent.
2. A completed implementation with an artifact selects a different review agent.
3. A reviewer approval moves the ticket to Done.
4. A reviewer change request creates a rework implementation run containing the feedback.
5. A ticket reaches human escalation after the configured review-round limit.
6. No A2A task is dispatched twice for the same persisted workflow run.
7. Existing worker-backed task behavior remains unchanged until cutover is explicitly enabled.

## Deferred

- Global or peer-to-peer agent discovery.
- Billing, cost optimization, reputation, and marketplace functionality.
- Automatic merges and deployments.
- Replacing external ticket systems; they remain optional ingress adapters.
- Removing every legacy worker/deployment module in the first implementation wave.
