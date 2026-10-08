import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskState } from '@a2a-js/sdk';
import { classifyAgentEventImportance, type AgentEvent, type AgentEventType } from '@ai-agent-board/shared/types.js';
import { agentEventToTaskUpdate, taskUpdateToAgentEvent } from '../src/events.ts';
import { EXT_AGENT_EVENT } from '../src/extension.ts';

const ALL_EVENT_TYPES: readonly AgentEventType[] = [
  'thinking', 'tool_call', 'file_read', 'file_write', 'file_edit', 'command',
  'command_output', 'output', 'test_result', 'error', 'complete',
];

function boardEvent(type: AgentEventType, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: `evt-${type}`,
    taskId: 'task-1',
    type,
    content: `content for ${type}`,
    timestamp: 1_700_000_000_000,
    importance: classifyAgentEventImportance(type),
    ...overrides,
  };
}

test('every AgentEventType round-trips through A2A unchanged', () => {
  for (const type of ALL_EVENT_TYPES) {
    const event = boardEvent(type, { metadata: { file: 'src/a.ts', duration: 12 } });
    const update = agentEventToTaskUpdate(event, { contextId: 'ctx-1' });
    const back = taskUpdateToAgentEvent(update);
    assert.ok(back, `no event decoded for ${type}`);
    assert.equal(back.id, event.id, type);
    assert.equal(back.taskId, event.taskId, type);
    assert.equal(back.type, event.type, type);
    assert.equal(back.timestamp, event.timestamp, type);
    assert.equal(back.importance, event.importance, type);
    assert.deepEqual(back.metadata, event.metadata, type);
  }
});

test('completion becomes an artifact update, progress becomes a status update', () => {
  const complete = agentEventToTaskUpdate(boardEvent('complete'), { contextId: 'ctx-1', summary: 'Added rate limiting.' });
  assert.equal(complete.kind, 'artifactUpdate');
  assert.equal(complete.data.contextId, 'ctx-1');
  if (complete.kind === 'artifactUpdate') {
    assert.equal(complete.data.lastChunk, true);
    assert.equal(complete.data.artifact?.name, 'run-result');
    assert.equal(complete.data.artifact?.parts[0]?.content?.$case, 'text');
    assert.equal(
      complete.data.artifact?.parts[0]?.content?.$case === 'text'
        ? complete.data.artifact.parts[0].content.value
        : undefined,
      'Added rate limiting.',
    );
  }

  const progress = agentEventToTaskUpdate(boardEvent('thinking'), { contextId: 'ctx-1' });
  assert.equal(progress.kind, 'statusUpdate');
  if (progress.kind === 'statusUpdate') {
    assert.equal(progress.data.status?.state, TaskState.TASK_STATE_WORKING);
    assert.equal(progress.data.status?.timestamp, new Date(1_700_000_000_000).toISOString());
  }
});

test('an error event is a terminal failed status update', () => {
  const update = agentEventToTaskUpdate(boardEvent('error', { content: 'boom' }), { contextId: 'ctx-1' });
  assert.equal(update.kind, 'statusUpdate');
  if (update.kind === 'statusUpdate') {
    assert.equal(update.data.status?.state, TaskState.TASK_STATE_FAILED);
  }
});

test('milestones carry a structured data part, details do not', () => {
  const milestone = agentEventToTaskUpdate(
    boardEvent('file_write', { metadata: { file: 'src/a.ts', diff: '@@ -1 +1 @@' } }),
    { contextId: 'ctx-1' },
  );
  const detail = agentEventToTaskUpdate(
    boardEvent('thinking', { metadata: { file: 'src/a.ts' } }),
    { contextId: 'ctx-1' },
  );
  const partCases = (update: typeof milestone): string[] => (update.kind === 'statusUpdate'
    ? (update.data.status?.message?.parts ?? []).map((part) => part.content?.$case ?? 'none')
    : []);
  assert.deepEqual(partCases(milestone), ['text', 'data']);
  assert.deepEqual(partCases(detail), ['text']);
});

test('a foreign A2A status update without the board extension still decodes', () => {
  const decoded = taskUpdateToAgentEvent({
    kind: 'statusUpdate',
    data: {
      taskId: 'task-9',
      contextId: 'ctx-9',
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: {
          messageId: 'm-1',
          contextId: 'ctx-9',
          taskId: 'task-9',
          role: 2,
          parts: [{ content: { $case: 'text', value: 'working on it' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: undefined,
      },
      metadata: undefined,
    },
  });
  assert.ok(decoded);
  assert.equal(decoded.type, 'output');
  assert.equal(decoded.content, 'working on it');
  assert.equal(decoded.taskId, 'task-9');
});

test('a foreign failed status update decodes as an error event', () => {
  const decoded = taskUpdateToAgentEvent({
    kind: 'statusUpdate',
    data: {
      taskId: 'task-9',
      contextId: 'ctx-9',
      status: { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: undefined },
      metadata: undefined,
    },
  });
  assert.equal(decoded?.type, 'error');
  assert.equal(decoded?.importance, 'milestone');
});

test('the event envelope rides in metadata under the board extension key', () => {
  const update = agentEventToTaskUpdate(boardEvent('command'), { contextId: 'ctx-1' });
  assert.ok(update.data.metadata?.[EXT_AGENT_EVENT], 'envelope missing');
});
