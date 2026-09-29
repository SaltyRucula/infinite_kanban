import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyV2InputRequest, classifyV2Terminal, mapV2Event, type V2RawEvent } from '../src/v2-events.js';
import type { CoreEvent } from '../src/types.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Loads a captured NDJSON fixture. Lines are either raw SSE (`data: {...}`)
 * or bare JSON; heartbeat/comment lines (`: heartbeat`) and blank lines are
 * skipped. Any line that still fails to parse as JSON is skipped rather than
 * thrown on — fixtures are real captures and may contain incidental noise.
 */
function loadFixture(name: string): V2RawEvent[] {
  const content = readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  const events: V2RawEvent[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(':')) continue;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        events.push(parsed as V2RawEvent);
      }
    } catch {
      // not a JSON payload line (defensive; not expected in these captures)
    }
  }
  return events;
}

const ALL_FIXTURES = [
  'events2.ndjson',
  'spike-tool-error.ndjson',
  'spike-edit.ndjson',
  'spike-form.ndjson',
  'spike-form-cancel.ndjson',
  'spike-interrupt.ndjson',
  'spike-perm-reject.ndjson',
];

function mapAll(events: V2RawEvent[]): CoreEvent[] {
  const mapped: CoreEvent[] = [];
  for (const raw of events) {
    const event = mapV2Event(raw);
    if (event) mapped.push(event);
  }
  return mapped;
}

test('events2.ndjson: ordered sequence with text output and a surfaced tool call, no duplicate text', () => {
  const raw = loadFixture('events2.ndjson');
  const mapped = mapAll(raw);

  // The shell tool call ("echo hello-from-tool") must be surfaced.
  const toolCallIndex = mapped.findIndex((e) => e.type === 'command' && e.content === 'echo hello-from-tool');
  assert.notEqual(toolCallIndex, -1, 'expected the shell tool call to be surfaced as a command event');

  // The final assistant reply ("DONE") must appear exactly once — the fixture
  // contains one session.text.delta with delta "DONE" followed by a
  // session.text.ended repeating the same full text; our dedup strategy
  // (emit on .delta, drop .ended) must not double-emit it.
  const doneOutputs = mapped.filter((e) => e.type === 'output' && e.content === 'DONE');
  assert.equal(doneOutputs.length, 1, 'expected exactly one output event for the final "DONE" reply');

  const doneIndex = mapped.findIndex((e) => e.type === 'output' && e.content === 'DONE');
  assert.ok(doneIndex > toolCallIndex, 'expected the tool call to precede the final text output');

  // No event anywhere in this mapped sequence should be a duplicate of any
  // other in both type+content (a slightly stronger blanket dedup check).
  const seen = new Set<string>();
  for (const e of mapped) {
    if (e.type === 'output' || e.type === 'thinking') {
      const key = `${e.type}:${e.content}`;
      assert.ok(!seen.has(key) || e.content === '\n', `duplicate ${e.type} content detected: ${JSON.stringify(e.content)}`);
      seen.add(key);
    }
  }
});

test('spike-tool-error.ndjson: session.tool.failed (tool.execution) produces an error CoreEvent', () => {
  const raw = loadFixture('spike-tool-error.ndjson');
  const failedRaw = raw.find(
    (e) => e.type === 'session.tool.failed' && (e.data?.error as { type?: string } | undefined)?.type === 'tool.execution',
  );
  assert.ok(failedRaw, 'fixture must contain a session.tool.failed event with error.type "tool.execution"');

  const mapped = mapV2Event(failedRaw!);
  assert.ok(mapped);
  assert.equal(mapped!.type, 'error');
  assert.equal(
    mapped!.content,
    'Could not find oldString in config.yaml. It must match exactly, including whitespace and indentation.',
  );
});

test('spike-tool-error.ndjson: session.tool.success with non-zero exit is NOT mapped to an error event', () => {
  const raw = loadFixture('spike-tool-error.ndjson');
  const successRaw = raw.find(
    (e) => e.type === 'session.tool.success' && (e.data?.metadata as { exit?: number } | undefined)?.exit === 3,
  );
  assert.ok(successRaw, 'fixture must contain a session.tool.success event with metadata.exit === 3');

  const mapped = mapV2Event(successRaw!);
  assert.ok(mapped, 'a non-zero exit tool success must still be mapped (it is not dropped)');
  assert.notEqual(mapped!.type, 'error', 'a non-zero shell exit code must NOT be treated as a tool failure');
  assert.equal(mapped!.type, 'command_output');
  assert.ok(mapped!.content.includes('exited with code 3'));
});

test('spike-form.ndjson: classifyV2InputRequest returns the real form id', () => {
  const raw = loadFixture('spike-form.ndjson');
  const formCreated = raw.find((e) => e.type === 'form.created');
  assert.ok(formCreated, 'fixture must contain a form.created event');

  const result = classifyV2InputRequest(formCreated!);
  assert.deepEqual(result, { kind: 'form', formID: 'frm_0e864766a001TFlDFGHUFxgnKM' });

  // mapV2Event must also surface this as a visible clarification event, not
  // silently drop it (a caller relying only on mapV2Event's output stream
  // would otherwise never learn a question is pending).
  const mapped = mapV2Event(formCreated!);
  assert.ok(mapped);
  assert.equal(mapped!.type, 'command');
  assert.ok(mapped!.metadata?.clarification_request);
  assert.equal((mapped!.metadata!.clarification_request as { requestId: string }).requestId, 'frm_0e864766a001TFlDFGHUFxgnKM');
});

test('permission.asked event: classifyV2InputRequest returns the real request id', () => {
  const raw = loadFixture('spike-perm-reject.ndjson');
  const permissionAsked = raw.find((e) => e.type === 'permission.asked');
  assert.ok(permissionAsked, 'fixture must contain a permission.asked event');

  const result = classifyV2InputRequest(permissionAsked!);
  assert.deepEqual(result, { kind: 'permission', requestID: 'per_0e86c84390018mgn8nZGmnJIIT' });

  const mapped = mapV2Event(permissionAsked!);
  assert.ok(mapped);
  assert.equal(mapped!.type, 'command');
  assert.ok(mapped!.metadata?.clarification_request);
});

test('classifyV2Terminal: interrupted, succeeded, failed from their respective fixtures', () => {
  const interruptRaw = loadFixture('spike-interrupt.ndjson').find((e) => e.type === 'session.execution.interrupted');
  assert.ok(interruptRaw);
  assert.equal(classifyV2Terminal(interruptRaw!), 'interrupted');

  const succeededRaw = loadFixture('events2.ndjson').find((e) => e.type === 'session.execution.succeeded');
  assert.ok(succeededRaw);
  assert.equal(classifyV2Terminal(succeededRaw!), 'succeeded');

  const failedRaw = loadFixture('spike-tool-error.ndjson').find((e) => e.type === 'session.execution.failed');
  assert.ok(failedRaw);
  assert.equal(classifyV2Terminal(failedRaw!), 'failed');

  // Non-terminal events must not be misclassified.
  assert.equal(classifyV2Terminal({ type: 'session.text.delta' }), null);
});

test('mapV2Event never throws on unknown or malformed events', () => {
  assert.equal(mapV2Event({ type: 'session.totally.new' }), null);
  assert.equal(mapV2Event({ type: 'x' }), null);
  // Missing `data` entirely on an event type that requires it.
  assert.equal(mapV2Event({ type: 'session.text.delta' }), null);
  assert.equal(mapV2Event({ type: 'session.tool.failed' } as V2RawEvent)?.type, 'error');
  // Malformed: data is not an object.
  assert.equal(
    mapV2Event({ type: 'session.text.delta', data: 'not-an-object' as unknown as Record<string, unknown> }),
    null,
  );
  // No type at all.
  assert.equal(mapV2Event({} as V2RawEvent), null);
  assert.equal(mapV2Event(null as unknown as V2RawEvent), null);
  assert.equal(mapV2Event(undefined as unknown as V2RawEvent), null);

  // classifyV2Terminal / classifyV2InputRequest must be equally defensive.
  assert.equal(classifyV2Terminal(null as unknown as V2RawEvent), null);
  assert.equal(classifyV2InputRequest(undefined as unknown as V2RawEvent), null);
  assert.equal(classifyV2InputRequest({ type: 'form.created' }), null);
  assert.equal(classifyV2InputRequest({ type: 'form.created', data: {} }), null);
  assert.equal(classifyV2InputRequest({ type: 'permission.asked', data: {} }), null);
});

test('path-leak guard: no mapped CoreEvent ever contains the fixture workspace directory', () => {
  for (const fixtureName of ALL_FIXTURES) {
    const events = loadFixture(fixtureName);
    const directory = events.map((e) => e.location?.directory).find((d): d is string => typeof d === 'string' && d.length > 0);
    assert.ok(directory, `fixture ${fixtureName} should carry at least one location.directory to test against`);

    for (const raw of events) {
      const mapped = mapV2Event(raw);
      if (!mapped) continue;
      assert.ok(
        !mapped.content.includes(directory!),
        `${fixtureName}: mapped content for ${raw.type} leaked the workspace directory: ${mapped.content}`,
      );
      if (mapped.metadata) {
        for (const [key, value] of Object.entries(mapped.metadata)) {
          if (typeof value === 'string') {
            assert.ok(
              !value.includes(directory!),
              `${fixtureName}: metadata.${key} for ${raw.type} leaked the workspace directory: ${value}`,
            );
          } else if (value && typeof value === 'object') {
            const serialized = JSON.stringify(value);
            assert.ok(
              !serialized.includes(directory!),
              `${fixtureName}: metadata.${key} for ${raw.type} leaked the workspace directory: ${serialized}`,
            );
          }
        }
      }
    }
  }
});
