import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAgentEventImportance } from '../src/types.js';
import type { AgentEventType } from '../src/types.js';

const MILESTONE_TYPES: AgentEventType[] = [
  'file_write',
  'file_edit',
  'command',
  'test_result',
  'request_work',
  'error',
  'complete',
];

const DETAIL_TYPES: AgentEventType[] = [
  'thinking',
  'output',
  'tool_call',
  'file_read',
  'command_output',
];

test('classifyAgentEventImportance classifies discrete, human-meaningful events as milestone', () => {
  for (const type of MILESTONE_TYPES) {
    assert.equal(classifyAgentEventImportance(type), 'milestone', `expected ${type} to be milestone`);
  }
});

test('classifyAgentEventImportance classifies streaming/read-only chatter as detail', () => {
  for (const type of DETAIL_TYPES) {
    assert.equal(classifyAgentEventImportance(type), 'detail', `expected ${type} to be detail`);
  }
});

test('classifyAgentEventImportance covers all 12 AgentEventType values exactly once', () => {
  const all = [...MILESTONE_TYPES, ...DETAIL_TYPES];
  assert.equal(all.length, 12);
  assert.equal(new Set(all).size, 12);
});

test('classifyAgentEventImportance always marks error and complete as milestone (never collapsed)', () => {
  assert.equal(classifyAgentEventImportance('error'), 'milestone');
  assert.equal(classifyAgentEventImportance('complete'), 'milestone');
});

test('classifyAgentEventImportance marks output as detail (raw token streaming, not the human-facing conclusion)', () => {
  assert.equal(classifyAgentEventImportance('output'), 'detail');
});
