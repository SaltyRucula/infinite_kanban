import assert from 'node:assert/strict';
import test from 'node:test';
import { isA2AWorkflowEnabled } from '../src/services/a2a-workflow-feature.js';

test('keeps A2A workflow dispatch disabled unless explicitly enabled', () => {
  assert.equal(isA2AWorkflowEnabled({}), false);
  assert.equal(isA2AWorkflowEnabled({ A2A_WORKFLOW_ENABLED: 'false' }), false);
  assert.equal(isA2AWorkflowEnabled({ A2A_WORKFLOW_ENABLED: 'TRUE' }), false);
  assert.equal(isA2AWorkflowEnabled({ A2A_WORKFLOW_ENABLED: 'true' }), true);
});
