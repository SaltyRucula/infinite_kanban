# Board-owned implementation → review

Status: **Runtime slice implemented and OpenCode→OpenCode A2A execution verified; full two-harness acceptance remains blocked by Codex authentication.**
Date: October 10, 2026
Scope: the next execution slice for `infinite_kanban`

## Goal

**The board owns workflow; workers own execution.** Replace an executor without
rewriting the task definition or board orchestration. Use the existing A2A
execution boundary, with harness-specific code behind endpoint adapters.

This document refines [the A2A-first proposal](../proposals/a2a-first-rework.md)
and complements [the protocol adoption spec](a2a-protocol-adoption.md). Where
older proposals imply that review approval always closes a ticket, this
contract takes precedence: **board approval policy decides closure**.

```text
Board assigns implementation
    → executor returns a revision + evidence
Board assigns review of that exact revision
    → reviewer returns findings + verdict
Board applies policy
    → request changes, await human approval, or finish
```

Neither agent chooses its successor or moves the card directly. An endpoint
reports an outcome; the board validates it and decides the next transition.
An A2A execution task completing is not equivalent to a board ticket finishing.

## Ownership boundary

| Board owns | Execution endpoint owns |
|---|---|
| Tasks, dependencies and handoffs | Harness and model selection |
| Routing by required capabilities | Local workspace and repository setup |
| Assignment and run identity | Harness sessions and tool execution |
| Budgets, deadlines and approval policy | Enforcing execution restrictions |
| Durable history and accepted results | Progress, artifacts and evidence |

Constraints originate in the board; enforcement happens at the endpoint.
**An endpoint must reject an assignment it cannot enforce**, before starting
execution. Prompt instructions alone are not enforcement. In particular,
disabling edit tools while leaving unrestricted shell access is not a
read-only review guarantee.

Board budget policy may limit dispatches, rounds and duration. A hard execution
or spending limit is offered only when the endpoint can actually enforce it;
otherwise it must reject that requirement. Report observed usage separately
from guarantees, and do not claim a distributed billing ledger exists.

## Product contract

- A task requests `implementation` or `review`, not “run OpenCode.”
- An endpoint advertises roles/capabilities, portable repository access and
  supported restrictions, rather than only a harness name.
- Harness/model defaults live in endpoint configuration. An optional explicit
  override is an execution preference, not part of the workflow definition;
  unsupported overrides must be rejected rather than silently substituted.
- Project authorization and endpoint consent remain necessary. Advertising a
  capability does not grant access to a project or repository.
- Completion and review return validated structured results. Narrative output
  is useful evidence, but `REVIEW_VERDICT:` and other prose markers are not
  authoritative settlement inputs for this new path.
- Only board code accepts results and changes workflow state. Endpoint
  credentials must not grant general task editing or successor assignment.
- Preserve machine-local workspace resolution. Wire payloads contain portable
  repository identities, never board-host paths, credentials or harness caches.

## Assignment and result envelope

The following are **proposed contract fields**, not claims that these fields
already exist in the shared types. Define and validate the eventual envelope
once in the shared contract, and carry it in A2A structured data parts/artifacts
using the repository's existing mapping package and outbound allowlist.

| Assignment field | Meaning |
|---|---|
| `schemaVersion` | Explicit version of this execution contract |
| `taskId`, `workflowRunId` | Board ticket and durable workflow identity |
| `assignmentId`, `attempt` | Board-issued assignment identity and attempt number |
| `role` | `implementation` or `review` |
| `repository` | Portable repository identity resolved locally by the endpoint |
| `baseRevision` | Immutable starting commit/artifact identity |
| `targetRevision` | Required immutable subject for review |
| `requirements`, `requiredCapabilities` | Task intent and eligibility requirements |
| `constraints` | Deadline, execution restrictions and enforceable limits |
| `parentImplementationAssignmentId` | Review/rework provenance where applicable |

Every result identifies its `schemaVersion`, `taskId`, `workflowRunId`,
`assignmentId`, `attempt`, role and producing endpoint. The board binds these to
its authenticated dispatch record, not to a peer's self-asserted identity.
An implementation result includes its immutable output revision, summary and
evidence. A review result includes its exact reviewed revision, structured
findings, evidence and a verdict (`approved` or `changes_requested`). Findings
include severity, actionable explanation and a location where available.
Evidence records what was checked, the revision checked, the actual outcome
and retrievable artifact references. Empty or incomplete findings/evidence
never imply approval.

Before settlement the board checks:

1. The schema and required fields are valid; unknown/private fields are refused.
2. The endpoint, assignment and attempt match the currently active dispatch.
3. The result's revision matches the assignment and evidence subject.
4. Required artifacts and checks exist and meet the task's acceptance policy.
5. The result has not already been accepted; duplicates are idempotent.

Persist rejected/late responses as diagnostic history without mutating the
current run. A result from attempt 1 must never complete attempt 2. Preserve
accepted results across retries and restarts; do not overwrite history with
the latest narrative summary.

## Immutable review and board policy

An implementation must publish a commit or content-addressed artifact the
review endpoint can resolve. A branch name, mutable URL or shared working tree
alone is not a review target. The endpoint verifies the requested identity and
reviews it in an isolated workspace; moving the branch or editing the original
checkout must not change the review subject. An inaccessible or mismatched
revision fails acceptance/admission rather than triggering a fallback to HEAD.

Board transitions are driven by accepted results, not the current card column:

| Event | Board decision |
|---|---|
| Accepted implementation result | Record revision/evidence; queue independent review |
| Accepted review with `changes_requested` | Create a new implementation assignment with findings and reviewed revision, within round/budget limits |
| Accepted review with `approved`, human approval required | Await a recorded human decision on that exact revision; do not mark Done |
| Accepted review with `approved`, automatic finish permitted | Finish the ticket |
| Required human approval granted | Finish only if the approved revision is still the accepted revision |
| Limits exhausted or result cannot be accepted | Escalate with a visible reason; do not silently loop or finish |

The reviewer must be a distinct endpoint identity from the implementer. This
is minimum identity separation, not a claim that two registrations guarantee
independent people or models. A new implementation revision invalidates prior
review/human approval and requires a new review. Dependencies advance only
when the board's completion policy has been satisfied.

## Failure accounting

| Category | Example | Required behavior |
|---|---|---|
| Dispatch failure | No eligible endpoint, unreachable endpoint, assignment refused, no confirmed pickup | Record dispatch/admission outcome; do not label it “agent failed” |
| Execution failure | Accepted execution crashes, times out or cannot complete | Record the execution failure and evidence against that attempt |
| Acceptance failure | Completed execution returns malformed data, missing evidence or the wrong revision | Preserve the response; refuse settlement and expose the validation reason |

A transport timeout after sending is an **uncertain dispatch**, not proof of
non-execution. Reconcile the existing assignment over A2A before retrying;
retries must use durable correlation/idempotency so an ambiguous response does
not create duplicate work. Cancellation or replacement fences the old attempt
before another result can advance the ticket.

## Current code and gaps

| Surface | Existing foundation | Gap for this slice |
|---|---|---|
| `shared/types.ts` | Worker assignment allowlist, A2A roles, phases and agent project access | Versioned assignment/attempt/revision/result contracts |
| `packages/server/src/services/workflow-policy.ts` | Pure role routing, distinct reviewer, bounded rework | Revision/evidence acceptance and configurable human-approval policy; approval currently maps directly to `done` |
| `packages/server/src/services/a2a-workflow-client.ts` | Generic outbound A2A client and remote task updates | Structured execution/result mapping and durable dispatch reconciliation |
| `packages/a2a/` | Assignment, event, state and Agent Card mappings | Shared schemas for role capabilities, restrictions and accepted results |
| `packages/worker/src/a2a-server.ts` | A2A listener and dispatch callback | Endpoint completion currently emits no artifacts; new path must return actual structured outcomes |
| `packages/worker/src/sdk-runner.ts`, `local-runner.ts` | Existing execution adapters | A neutral endpoint adapter contract plus a second genuinely different harness |
| `packages/worker/src/review-mode.ts` | Review prompt, verdict parser, partial tool restrictions | Immutable review target, structured result, enforceable restrictions |
| `scripts/demo-two-agents.mjs` | Two OpenCode workers, manual REST reassignment and prose-verdict detection | Board-owned A2A handoff with unchanged definitions across two harnesses |

These foundations do **not** establish a working brain-agnostic workflow. The
existing two-worker demo remains a legacy example, not acceptance evidence for
this contract.

## Next slice and acceptance gates

Implement additively until the new path passes its gates. Do not add another
harness dropdown or retire the legacy execution path in this slice.

1. **Shared contracts and acceptance tests.** Add schema/allowlist tests for
   structured results, stale attempts, duplicate settlement, wrong revisions,
   absent evidence and endpoint refusals. No prose marker may pass acceptance.
2. **Durable board coordinator.** Wire routing, dispatch, acceptance, rework and
   human approval into the real run path. Prove recovery after restart and
   uncertain dispatch, cancellation fencing, reviewer separation and limits.
   Keep SQLite/PostgreSQL behavior aligned.
3. **Endpoint adapters.** Preserve OpenCode behind an adapter and provide one
   second harness behind the same endpoint interface. Advertise and enforce
   capabilities/restrictions; prove unsupported assignments are refused before
   any tool execution. Use isolated revision-pinned review workspaces.
4. **Two-harness proof.** Run the same implementation → review fixture through
   both genuine harnesses. Hold task requirements, workflow policy, result
   schema and coordinator code fixed; only endpoint configuration/routing
   changes. Include a mixed-harness handoff and a harness swap for the same
   role. Two OpenCode profiles or two mock endpoints alone do not count.
5. **Evidence and UI gate.** Capture real assignment/attempt IDs, immutable
   implementation and reviewed revisions, checks, verdicts and board decisions.
   Exercise approval, requested changes, human approval, stale results and all
   three failure categories with deterministic integration tests. Include
   affected board/browser e2e coverage and a green `npm run gate:required`.
   Report live harness availability/authentication blockers rather than
   substituting synthetic run output.

Done means the board can replace the executor **without rewriting the
workflow**, and actual two-harness execution proves it. Until those gates pass,
this document records the design and delivery requirements, not a shipped
runtime feature.

## Delivery status — October 10, 2026

The new standalone runtime path is now wired at
`POST /api/tasks/:id/workflow/run`, with durable SQLite/PostgreSQL coordinator
storage, structured assignment/result validation, artifact retrieval/digests,
revision-pinned independent review, bounded rework, explicit human approval,
cancellation fencing and explicit retry. Browser task details show workflow
state, IDs, revision, history, checks and approval. Legacy execution remains
separate and additive. See [runtime instructions](../board-owned-workflow.md)
for exact configuration, protocol tags, API and repeatable demo commands.

**Verified:** genuine OpenCode→OpenCode A2A execution reached Done only after
explicit board human approval; review and implementation checked the same
immutable commit `0d575b24c5670716db2279cd6cd02c0d305ea98d`. Workflow
`1bfa12ce-df2d-4702-b1c6-f3cf3fb7044f`; evidence report
`/Users/CTW01561/.hermes/cache/scratch/board-a2a-demo-2rvIPF/report.json`.
The endpoint performed actual node tests and the reviewer reported static
inspection, not fictitious shell test execution. Deterministic native-endpoint
browser coverage exercises pinned handoff and wrong/correct human approval.
`npm run gate:required` passed (146 regular e2e passed, 5 skipped; A2A UI
1 passed, 1 skipped). Server tests pass, and PostgreSQL SQL is validated using
pg-mem; a live PostgreSQL deployment is not claimed.

**Still open:** the full acceptance definition is not satisfied. The real mixed
OpenCode→Codex attempt failed with 401 Unauthorized, and Codex's own CLI reports
Not logged in. An authenticated second-harness run and successful same-role
swap remain blocked, rather than being replaced with mocks. The latest OpenCode
repeat also failed at review with provider `Unauthorized`; the preserved successful
run is genuine, but reliable subsequent live replays are not claimed. Standalone tasks
are supported; group workflow dispatch is explicitly refused. Endpoint source
publication is local by default; remote-machine commit transport must be
configured independently. External endpoints that cannot reconcile a lost
receipt by durable assignment correlation remain visibly uncertain, without
blind retries. No distributed billing guarantee is claimed.

