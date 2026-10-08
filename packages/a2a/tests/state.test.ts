import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskState } from '@a2a-js/sdk';
import type { AgentStatus, ColumnId } from '@ai-agent-board/shared/types.js';
import { fromTaskState, isTerminalTaskState, toTaskState } from '../src/state.ts';

const ALL_STATUSES: readonly AgentStatus[] = [
  'idle', 'planning', 'executing', 'awaiting_clarification', 'complete', 'failed',
];
const ALL_COLUMNS: readonly ColumnId[] = ['backlog', 'in-progress', 'pending', 'review', 'done'];

test('every board agentStatus maps to a defined A2A state', () => {
  for (const agentStatus of ALL_STATUSES) {
    for (const columnId of ALL_COLUMNS) {
      const state = toTaskState({ agentStatus, columnId });
      assert.notEqual(state, TaskState.TASK_STATE_UNSPECIFIED, `${agentStatus}/${columnId}`);
      assert.notEqual(state, TaskState.UNRECOGNIZED, `${agentStatus}/${columnId}`);
    }
  }
});

test('lifecycle maps to the states the spec requires', () => {
  assert.equal(toTaskState({ agentStatus: 'idle', columnId: 'backlog' }), TaskState.TASK_STATE_SUBMITTED);
  assert.equal(toTaskState({ agentStatus: 'planning', columnId: 'in-progress' }), TaskState.TASK_STATE_WORKING);
  assert.equal(toTaskState({ agentStatus: 'executing', columnId: 'in-progress' }), TaskState.TASK_STATE_WORKING);
  assert.equal(
    toTaskState({ agentStatus: 'awaiting_clarification', columnId: 'pending' }),
    TaskState.TASK_STATE_INPUT_REQUIRED,
  );
  assert.equal(toTaskState({ agentStatus: 'complete', columnId: 'review' }), TaskState.TASK_STATE_COMPLETED);
  assert.equal(toTaskState({ agentStatus: 'complete', columnId: 'done' }), TaskState.TASK_STATE_COMPLETED);
  assert.equal(toTaskState({ agentStatus: 'failed', columnId: 'in-progress' }), TaskState.TASK_STATE_FAILED);
});

test('cancel and reject overrides win over the status mapping', () => {
  const lifecycle = { agentStatus: 'executing', columnId: 'in-progress' } as const;
  assert.equal(toTaskState(lifecycle, { canceled: true }), TaskState.TASK_STATE_CANCELED);
  assert.equal(toTaskState(lifecycle, { rejected: true }), TaskState.TASK_STATE_REJECTED);
  assert.equal(toTaskState(lifecycle, { canceled: true, rejected: true }), TaskState.TASK_STATE_REJECTED);
});

test('terminal states are exactly the four the spec names', () => {
  const terminal = [
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ];
  for (const state of terminal) assert.equal(isTerminalTaskState(state), true, String(state));
  for (const state of [
    TaskState.TASK_STATE_SUBMITTED,
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ]) {
    assert.equal(isTerminalTaskState(state), false, String(state));
  }
});

test('A2A states map back onto a valid board lifecycle', () => {
  assert.deepEqual(fromTaskState(TaskState.TASK_STATE_SUBMITTED), { agentStatus: 'idle' });
  assert.deepEqual(fromTaskState(TaskState.TASK_STATE_WORKING), { agentStatus: 'executing', columnId: 'in-progress' });
  assert.deepEqual(
    fromTaskState(TaskState.TASK_STATE_INPUT_REQUIRED),
    { agentStatus: 'awaiting_clarification', columnId: 'pending' },
  );
  assert.deepEqual(fromTaskState(TaskState.TASK_STATE_COMPLETED), { agentStatus: 'complete', columnId: 'review' });
  assert.deepEqual(fromTaskState(TaskState.TASK_STATE_FAILED), { agentStatus: 'failed' });
  assert.deepEqual(fromTaskState(TaskState.TASK_STATE_CANCELED), { agentStatus: 'failed' });
  assert.deepEqual(fromTaskState(TaskState.TASK_STATE_REJECTED), { agentStatus: 'failed' });
  assert.deepEqual(fromTaskState(TaskState.UNRECOGNIZED), { agentStatus: 'failed' });
});

test('round trip preserves the board lifecycle for non-overridden states', () => {
  for (const agentStatus of ALL_STATUSES) {
    if (agentStatus === 'planning') continue; // planning and executing both mean WORKING
    const state = toTaskState({ agentStatus, columnId: 'in-progress' });
    const back = fromTaskState(state);
    assert.equal(back.agentStatus, agentStatus, `${agentStatus} -> ${state} -> ${back.agentStatus}`);
  }
});
