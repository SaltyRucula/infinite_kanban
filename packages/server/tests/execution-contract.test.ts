import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAssignment, validateResult, type ExecutionAssignment } from '../../../shared/execution.js';
const revision = 'a'.repeat(40);
const assignment: ExecutionAssignment = { schemaVersion: 1, taskId: 't', projectId: 'p', workflowRunId: 'r', assignmentId: 'a', attempt: 1, role: 'review', endpointId: 'e', repository: 'https://github.com/org/repo', baseRevision: revision, targetRevision: revision, requirements: 'Review', requiredCapabilities: [], constraints: { deadline: 10000 } };
const result = { schemaVersion: 1, taskId: 't', workflowRunId: 'r', assignmentId: 'a', attempt: 1, role: 'review', endpointId: 'e', revision, summary: 'checked', verdict: 'approved', findings: [], evidence: [{ check: 'tests', revision, outcome: 'passed', artifact: 'urn:sha256:' + 'b'.repeat(64) }] };
test('accepts structured revision-pinned evidence, never prose, unknown/private fields, stale identity, wrong revisions or missing evidence', () => {
 assert.deepEqual(validateAssignment(assignment), assignment);
 assert.deepEqual(validateResult(result, assignment), result);
 for (const value of ['REVIEW_VERDICT: pass', {...result, repoPath:'/private'}, {...result, attempt:2}, {...result, endpointId:'other'}, {...result, revision:'b'.repeat(40)}, {...result, evidence:[]}, {...result, evidence:[{...result.evidence[0], credentials:'secret'}]}, {...result, evidence:[{...result.evidence[0], revision:'b'.repeat(40)}]}]) assert.throws(() => validateResult(value, assignment));
 assert.throws(() => validateAssignment({...assignment, harness:'codex'}));
 assert.throws(() => validateAssignment({...assignment, repository:'/board/path'}));
 assert.throws(() => validateAssignment({...assignment, targetRevision:'main'}));
 assert.throws(() => validateAssignment({...assignment, assignmentId:'../../escape'}));
 assert.throws(() => validateAssignment({...assignment, repository:'https://github.com/o/r?token=secret'}));
});
