import assert from 'node:assert/strict';import test from 'node:test';import {executionParts,executionArtifacts,resultFromArtifacts} from '../src/execution.js';
test('maps native v1 data parts/artifacts and rejects ambiguous or narrative results',()=>{
 const a:any={schemaVersion:1,taskId:'t',projectId:'p',workflowRunId:'r',assignmentId:'a',attempt:1,endpointId:'e',role:'implementation',repository:'https://github.com/o/r',baseRevision:'a'.repeat(40),requirements:'Implement',requiredCapabilities:[],constraints:{deadline:123}};
 const r:any={schemaVersion:1,taskId:'t',workflowRunId:'r',assignmentId:'a',attempt:1,endpointId:'e',role:'implementation',revision:'b'.repeat(40),summary:'Changed',evidence:[{check:'tests',revision:'b'.repeat(40),outcome:'passed',artifact:'urn:sha256:'+'c'.repeat(64)}]};
 assert.deepEqual(executionParts(a)[1],{data:a});assert.deepEqual(resultFromArtifacts(executionArtifacts(r)),r);
 assert.throws(()=>resultFromArtifacts([]));assert.throws(()=>resultFromArtifacts([...executionArtifacts(r),...executionArtifacts(r)]));assert.throws(()=>executionParts({...a,repoPath:'/private'}));
});
