import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentManager } from '../src/services/agent-manager.js';
import type { TaskRepository } from '../src/repositories/types.js';
import { classifyAgentEventImportance } from '../src/types.js';
import type { AgentEvent, Task } from '../src/types.js';

/** Minimal TaskRepository stub — only the event-persistence surface matters here. */
class StubTaskRepository implements Pick<TaskRepository, 'insertEvent' | 'getEventsByTaskId'> {
  readonly inserted: AgentEvent[] = [];

  async insertEvent(event: AgentEvent): Promise<void> {
    this.inserted.push(event);
  }

  async getEventsByTaskId(taskId: string): Promise<AgentEvent[]> {
    return this.inserted.filter((event) => event.taskId === taskId);
  }
}

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: `evt-${Math.random()}`,
    taskId: 'task-1',
    type: 'file_write',
    content: 'wrote a file',
    timestamp: Date.now(),
    ...overrides,
  };
}

test('emitEvent stamps importance = milestone on file_write events', () => {
  const manager = new AgentManager();
  const repo = new StubTaskRepository();
  manager.initEventPersistence(repo as unknown as TaskRepository);

  const event = makeEvent({ type: 'file_write', content: 'wrote src/index.ts' });
  (manager as unknown as { emitEvent(taskId: string, event: AgentEvent): void }).emitEvent('task-1', event);

  assert.equal(event.importance, 'milestone');
  assert.equal(event.importance, classifyAgentEventImportance('file_write'));
  assert.equal(repo.inserted.length, 1);
  assert.equal(repo.inserted[0].importance, 'milestone');
});

test('emitEvent stamps importance = detail on thinking events', () => {
  const manager = new AgentManager();
  const repo = new StubTaskRepository();
  manager.initEventPersistence(repo as unknown as TaskRepository);

  const event = makeEvent({ type: 'thinking', content: 'considering approach' });
  (manager as unknown as { emitEvent(taskId: string, event: AgentEvent): void }).emitEvent('task-1', event);

  assert.equal(event.importance, 'detail');
  assert.equal(event.importance, classifyAgentEventImportance('thinking'));
  assert.equal(repo.inserted.length, 1);
  assert.equal(repo.inserted[0].importance, 'detail');
});

test('emitEvent preserves an explicitly-preset importance instead of overwriting it', () => {
  const manager = new AgentManager();
  const repo = new StubTaskRepository();
  manager.initEventPersistence(repo as unknown as TaskRepository);

  // 'thinking' would normally classify as 'detail' — explicit value should win.
  const event = makeEvent({ type: 'thinking', content: 'considering approach', importance: 'milestone' });
  (manager as unknown as { emitEvent(taskId: string, event: AgentEvent): void }).emitEvent('task-1', event);

  assert.equal(event.importance, 'milestone');
  assert.equal(repo.inserted[0].importance, 'milestone');
});
