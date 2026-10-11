import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJsonDocument } from '../src/harness-output.js';

/**
 * Harnesses differ in how disciplined their final message is. OpenCode returns
 * the bare document, Copilot narrates first ("I'll examine the files...") and
 * Claude tends to fence its JSON. The settlement contract still demands a
 * structured document — this only locates it inside the transport text.
 */
test('accepts a bare JSON document', () => {
  assert.deepEqual(extractJsonDocument('{"summary":"done"}'), { summary: 'done' });
  assert.deepEqual(extractJsonDocument('  \n {"summary":"done"}\n '), { summary: 'done' });
});

test('accepts a fenced document', () => {
  assert.deepEqual(extractJsonDocument('```json\n{"summary":"done"}\n```'), { summary: 'done' });
  assert.deepEqual(extractJsonDocument('```\n{"summary":"done"}\n```'), { summary: 'done' });
});

test('accepts a document that follows narration', () => {
  const copilot = `I'll examine the files first.\n\nLooking at add.cjs, the operator is wrong.\n\n{"summary":"Fixed add.cjs"}`;
  assert.deepEqual(extractJsonDocument(copilot), { summary: 'Fixed add.cjs' });
});

test('takes the final document when the model shows an example first', () => {
  const text = 'I will answer in the form {"summary":"..."} as instructed.\n\n{"summary":"the real one"}';
  assert.deepEqual(extractJsonDocument(text), { summary: 'the real one' });
});

test('handles braces inside strings without truncating the document', () => {
  const text = 'Report:\n{"summary":"changed the {curly} helper","verdict":"approved","findings":[]}';
  assert.deepEqual(extractJsonDocument(text), {
    summary: 'changed the {curly} helper', verdict: 'approved', findings: [],
  });
});

test('handles a nested document', () => {
  const text = 'ok\n{"summary":"s","verdict":"changes_requested","findings":[{"severity":"error","explanation":"bad"}]}';
  const value = extractJsonDocument(text) as { findings: unknown[] };
  assert.equal(value.findings.length, 1);
});

test('refuses text with no document, naming what was expected', () => {
  assert.throws(() => extractJsonDocument('REVIEW_VERDICT: pass'), /structured JSON/i);
  assert.throws(() => extractJsonDocument(''), /structured JSON/i);
  // A truncated document must fail rather than be silently repaired.
  assert.throws(() => extractJsonDocument('{"summary":"unterminated'), /structured JSON/i);
});

test('refuses a non-object document', () => {
  assert.throws(() => extractJsonDocument('["summary"]'), /structured JSON/i);
  assert.throws(() => extractJsonDocument('42'), /structured JSON/i);
});
