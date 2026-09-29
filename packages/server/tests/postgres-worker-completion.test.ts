import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { PostgresTaskRepository } from '../src/repositories/postgres.js';

// Repository tests elsewhere (agent-type-opencode-migration.test.ts) establish
// the pattern used here: a fake `Pick<Pool, 'query'>` that records the SQL
// text/params sent and returns a canned row, letting us assert what
// PostgresTaskRepository actually sends to Postgres and how it maps a
// returned row back to a Task — without a real Postgres server. This does
// NOT execute the SQL (no CASE/WHERE evaluation happens here); it is
// complementary to, not a replacement for, the reviewer's manual read-based
// verification that this SQL is a strict superset of the SQLite
// implementation. There is no other existing pattern in this repo for
// spinning up a real Postgres instance for tests, so that deeper coverage is
// intentionally out of scope here (see AGENTS.md/task instructions: use an
// existing pattern or skip rather than inventing infrastructure).

function fullRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    title: 'Task',
    description: 'desc',
    priority: 'medium',
    column_id: 'review',
    agent_status: 'complete',
    created_at: '1',
    started_at: null,
    completed_at: '2',
    repo_path: null,
    branch_name: null,
    base_branch: null,
    use_worktree: null,
    worktree_path: null,
    agent_type: 'opencode',
    archived: false,
    project_id: 'default',
    group_id: null,
    group_order: null,
    summary: 'All good',
    external_source: null,
    external_key: null,
    provenance: null,
    run_requested_at: null,
    run_claimed_at: null,
    timeout_minutes: null,
    clarification_request: null,
    clarification_answer: null,
    assigned_worker_id: 'worker-1',
    worker_claim_token_hash: null,
    worker_claimed_at: null,
    worker_lease_expires_at: null,
    worker_attempt: 0,
    labels: '[]',
    agent_preference: null,
    ...overrides,
  };
}

test('PostgresTaskRepository.completeWorkerTask sends the atomic completion UPDATE with the expected params and forces column_id to review on a complete status', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const pool = {
    async query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
      queries.push({ text, params: params ?? [] });
      return { rows: [fullRow()] };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresTaskRepository(pool as Pool);
  const result = await repo.completeWorkerTask('task-1', 'worker-1', 'hash-abc', 'complete', 2, 'All good', undefined);

  assert.equal(queries.length, 1);
  const [query] = queries;
  // The atomic write: agent_status, completed_at, summary, the column_id
  // CASE (forcing 'review' on complete; 'pending' -> 'in-progress'
  // otherwise), and clearing clarification/run/lease state all in one
  // statement.
  assert.match(query.text, /UPDATE tasks SET/);
  assert.match(query.text, /column_id = CASE WHEN \$1 = 'complete' THEN 'review' WHEN column_id = 'pending' THEN 'in-progress' ELSE column_id END/);
  assert.match(query.text, /clarification_request = NULL/);
  assert.match(query.text, /clarification_answer = NULL/);
  assert.match(query.text, /run_requested_at = NULL/);
  assert.match(query.text, /run_claimed_at = NULL/);
  assert.match(query.text, /worker_claim_token_hash = NULL/);
  assert.match(query.text, /worker_lease_expires_at = NULL/);
  assert.deepEqual(query.params, ['complete', 2, 'All good', 'task-1', 'worker-1', 'hash-abc']);

  // Mapping a returned row back to a Task (parity with the SQLite mapping).
  assert.equal(result?.id, 'task-1');
  assert.equal(result?.columnId, 'review');
  assert.equal(result?.agentStatus, 'complete');
  assert.equal(result?.summary, 'All good');
});

test('PostgresTaskRepository.completeWorkerTask falls back to the error message when no summary is given', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const pool = {
    async query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
      queries.push({ text, params: params ?? [] });
      return { rows: [fullRow({ agent_status: 'failed', summary: 'boom' })] };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresTaskRepository(pool as Pool);
  await repo.completeWorkerTask('task-1', 'worker-1', 'hash-abc', 'failed', 2, undefined, 'boom');

  assert.equal(queries[0]?.params[2], 'boom');
});

test('PostgresTaskRepository.completeWorkerTask returns undefined when the claim/lease predicate matches no row', async () => {
  const pool = {
    async query(): Promise<{ rows: Array<Record<string, unknown>> }> {
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresTaskRepository(pool as Pool);
  const result = await repo.completeWorkerTask('task-1', 'worker-1', 'wrong-hash', 'complete', 2, 'summary', undefined);

  assert.equal(result, undefined);
});

test('PostgresTaskRepository.parkWorkerTaskForClarification sends the atomic park UPDATE with column_id=pending and the serialized clarification request', async () => {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const clarificationRequest = { requestId: 'req-1', prompt: 'Which env?', timestamp: 5, sessionId: 'ses-1' };
  const pool = {
    async query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
      queries.push({ text, params: params ?? [] });
      return {
        rows: [fullRow({
          agent_status: 'awaiting_clarification',
          column_id: 'pending',
          completed_at: null,
          clarification_request: JSON.stringify(clarificationRequest),
        })],
      };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresTaskRepository(pool as Pool);
  const result = await repo.parkWorkerTaskForClarification('task-1', 'worker-1', 'hash-abc', 5, clarificationRequest);

  assert.equal(queries.length, 1);
  const [query] = queries;
  assert.match(query.text, /UPDATE tasks SET/);
  assert.match(query.text, /agent_status = 'awaiting_clarification'/);
  assert.match(query.text, /column_id = 'pending'/);
  assert.match(query.text, /completed_at = NULL/);
  assert.match(query.text, /clarification_answer = NULL/);
  assert.match(query.text, /run_requested_at = NULL/);
  assert.match(query.text, /run_claimed_at = NULL/);
  assert.match(query.text, /worker_claim_token_hash = NULL/);
  assert.match(query.text, /worker_lease_expires_at = NULL/);
  assert.deepEqual(query.params, [JSON.stringify(clarificationRequest), 'task-1', 'worker-1', 'hash-abc', 5]);

  assert.equal(result?.columnId, 'pending');
  assert.equal(result?.agentStatus, 'awaiting_clarification');
  assert.deepEqual(result?.clarificationRequest, clarificationRequest);
});

test('PostgresTaskRepository.parkWorkerTaskForClarification returns undefined when the claim/lease predicate matches no row', async () => {
  const pool = {
    async query(): Promise<{ rows: Array<Record<string, unknown>> }> {
      return { rows: [] };
    },
  } as Pick<Pool, 'query'>;

  const repo = new PostgresTaskRepository(pool as Pool);
  const result = await repo.parkWorkerTaskForClarification('task-1', 'worker-1', 'wrong-hash', 5, {
    requestId: 'req-1', prompt: 'Which env?', timestamp: 5, sessionId: 'ses-1',
  });

  assert.equal(result, undefined);
});
