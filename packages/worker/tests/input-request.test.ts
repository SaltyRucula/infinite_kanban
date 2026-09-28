import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInputRequest, INPUT_REQUEST_MARKER } from '../src/input-request.js';

test('extractInputRequest recognizes a marker that starts the final line', () => {
  const text = 'Investigated the repo.\nNEEDS_INPUT: Which API version should the client target?';
  assert.equal(extractInputRequest(text), 'Which API version should the client target?');
});

test('extractInputRequest tolerates trailing blank lines after the marker line', () => {
  const text = 'Investigated the repo.\nNEEDS_INPUT: Which API version?\n\n  \n';
  assert.equal(extractInputRequest(text), 'Which API version?');
});

test('extractInputRequest returns undefined when there is no marker at all', () => {
  assert.equal(extractInputRequest('Implemented the feature and all tests pass.'), undefined);
});

// SHOULD-FIX 2 regression: the marker text is baked into the system prompt
// (INPUT_REQUEST_INSTRUCTIONS) every agent is handed, so a model that recaps
// its own instructions mid-response — without genuinely being blocked — must
// not be treated as asking a blocking question. The old `lastIndexOf` scan
// matched the marker ANYWHERE in the text and took *everything after* it as
// the question, which both false-parked finished work and produced huge
// "questions" that could exceed the server's length limit.
test('extractInputRequest ignores a mid-text recap of the marker when the final line does not start with it', () => {
  const recap = `If you are blocked, end your response with a line that starts with `
    + `\`${INPUT_REQUEST_MARKER}\` followed by your question. `
    + 'Implemented the feature and all tests pass.';
  assert.equal(extractInputRequest(recap), undefined);
});

test('extractInputRequest ignores an earlier line that happens to start with the marker', () => {
  const text = `${INPUT_REQUEST_MARKER} This was just an example format.\nAnyway, implementation complete, no real question here.`;
  assert.equal(extractInputRequest(text), undefined);
});

test('extractInputRequest requires the marker at the very start of the last line, not merely present in it', () => {
  const text = `Some context here, then a mention of ${INPUT_REQUEST_MARKER} mid-sentence on the final line.`;
  assert.equal(extractInputRequest(text), undefined);
});
