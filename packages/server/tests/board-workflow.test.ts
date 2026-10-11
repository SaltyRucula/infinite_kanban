import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteWorkflowStore } from '../src/repositories/workflow-store.js';
import { BoardWorkflowCoordinator } from '../src/services/board-workflow.js';
import type { Task, A2AAgent } from '../src/types.js';
import type { A2AMessageSendParams, A2ARemoteTaskUpdate } from '../src/services/a2a-workflow-client.js';
import type { ExecutionAssignment, ExecutionResult, ExecutionRole } from '@ai-agent-board/shared/execution.js';
const revision = 'a'.repeat(40), output = 'b'.repeat(40);
const agents: A2AAgent[] = ['implementer', 'reviewer'].map((id, i) => ({
 id, name: id, description: '', version: 'test', agentCardUrl: `http://localhost:${4100+i}/.well-known/agent-card.json`, enabled: true,
 endpoint: `http://localhost:${4100+i}/a2a/v1`, protocolVersion: '1.0', createdAt: 1, updatedAt: 1, lastValidatedAt: 1,
 projectAccess: [{ agentId: id, projectId: 'p', roles: [i ? 'review' : 'implementation'], createdAt: 1, updatedAt: 1 }],
 skills: [{ id: 'execution', name: 'Execution', tags: ['execution:v1', 'repository:github.com/o/r', 'consent:p', 'git:revision', 'review:snapshot'] }],
}));
function fixture() {
 const db = new Database(':memory:'); const store = new SqliteWorkflowStore(db);
 let task: Task = {id:'t',projectId:'p',title:'Do it',description:'Requirements',columnId:'backlog',agentStatus:'idle',agentType:'opencode',priority:'medium',labels:[],createdAt:1};
 const tasks = {getById:async()=>task,update:async(_id:string,u:Partial<Task>)=> {task={...task,...u};return task;}};
 const dispatches: A2AMessageSendParams[] = []; let uncertain = false;
 const updates = new Map<string,A2ARemoteTaskUpdate>();
 const executor = () => ({dispatch:async(p:A2AMessageSendParams)=> {dispatches.push(p);if(uncertain)throw new Error('timeout');return {remoteTaskId:p.message.messageId};},getUpdate:async(id:string):Promise<A2ARemoteTaskUpdate>=>updates.get(id) ?? {state:'running',artifacts:[]},cancel:async()=>{}});
 let roster = agents;
 const make = () => new BoardWorkflowCoordinator(store,tasks,{getAll:async()=>roster},executor,async()=>{});
 return {db,store,make,dispatches,updates,tasks,setAgents:(value:typeof agents)=>{roster=value;},setUncertain:()=>{uncertain=true;},task:()=>task};
}
function result(a:ExecutionAssignment, role:ExecutionRole, verdict:ExecutionResult['verdict']='approved'): ExecutionResult {
 const revision = role === 'implementation' ? output : a.targetRevision!;
 return {schemaVersion:1, taskId:a.taskId, workflowRunId:a.workflowRunId, assignmentId:a.assignmentId, attempt:a.attempt, role, endpointId:a.endpointId, revision, summary:'Checked', evidence:[{check:'test',revision,outcome:'passed',artifact:'urn:sha256:'+'c'.repeat(64)}], ...(role==='review'?{verdict,findings:verdict==='approved'?[]:[{severity:'error' as const,explanation:'fix bug'}]}:{})};
}
function clean(v:ExecutionResult): ExecutionResult {return JSON.parse(JSON.stringify(v));}
test('durably hands implementation to a distinct reviewer pinned to revision and requires exact human approval',async()=>{
 const f=fixture(); const c=f.make();
 let run=await c.start('t',{repository:'https://github.com/o/r',baseRevision:revision});
 assert.equal(f.dispatches.length,1);
 let a=run.assignments[0].assignment;
 await c.accept('t',clean(result(a,'implementation')),a.endpointId);
 run=(await f.make().get('t'))!;
 assert.equal(run.assignments.length,2); a=run.assignments[1].assignment;
 assert.equal(a.endpointId,'reviewer');assert.equal(a.targetRevision,output);
 await f.make().accept('t',clean(result(a,'review')),a.endpointId);
 assert.equal((await c.get('t'))?.phase,'awaiting_approval');assert.notEqual(f.task().columnId,'done');
 await assert.rejects(()=>c.approve('t',revision),/revision/);
 await c.approve('t',output,'operator');assert.equal((await c.get('t'))?.approvedBy,'operator');assert.ok((await c.get('t'))?.approvedAt);assert.equal(f.task().columnId,'done');
 const before=f.dispatches.length;await c.accept('t',clean(result(a,'review')),a.endpointId);assert.equal(f.dispatches.length,before);
 f.db.close();
});
test('uncertain send survives restart without blind duplicate and cancellation fences diagnostic late results',async()=>{
 const f=fixture();f.setUncertain();let c=f.make();let run=await c.start('t',{repository:'https://github.com/o/r',baseRevision:revision});
 assert.equal(run.phase,'dispatch_uncertain');c=f.make();await c.tick();assert.equal(f.dispatches.length,1);
 await c.cancel('t');const a=run.assignments[0].assignment;
 await c.accept('t',clean(result(a,'implementation')),a.endpointId);
 run=(await c.get('t'))!;assert.equal(run.phase,'canceled');assert.equal(run.diagnostics.length,2);assert.equal(run.diagnostics.at(-1)?.reason,'late/fenced result');assert.equal(f.dispatches.length,1);f.db.close();
});
test('recovers the persisted-before-dispatch checkpoint without losing the first assignment',async()=>{
 const f=fixture(),c=f.make();const run=await c.start('t',{repository:'https://github.com/o/r',baseRevision:revision});
 run.assignments=[];await f.store.save(run,run.version);const before=f.dispatches.length;
 await f.make().tick();assert.equal(f.dispatches.length,before+1);assert.equal((await c.get('t'))?.assignments.length,1);f.db.close();
});
test('rework preserves accepted history, invalidates approval, and escalates at the review round limit',async()=>{
 const f=fixture(),c=f.make();let run=await c.start('t',{repository:'https://github.com/o/r',baseRevision:revision,policy:{maxRounds:1}});let a=run.assignments[0].assignment;await c.accept('t',clean(result(a,'implementation')),a.endpointId);run=(await c.get('t'))!;a=run.assignments[1].assignment;await c.accept('t',clean(result(a,'review','changes_requested')),a.endpointId);run=(await c.get('t'))!;assert.equal(run.phase,'escalated');assert.equal(run.assignments.length,2);assert.equal(run.assignments[0].result?.revision,output);assert.match(run.diagnostics.at(-1)!.reason,/round limit/);f.db.close();
});
test('explicit retry fences the canceled attempt and preserves late diagnostic history',async()=>{
 const f=fixture(),c=f.make();const first=await c.start('t',{repository:'https://github.com/o/r',baseRevision:revision});const old=first.assignments[0].assignment;await c.cancel('t');await c.retry('t');await c.accept('t',clean(result(old,'implementation')),old.endpointId);const current=(await c.get('t'))!;assert.equal(current.assignments.length,2);assert.equal(current.assignments[0].state,'fenced');assert.equal(current.assignments[1].assignment.attempt,2);assert.equal(current.phase,'implementing');assert.equal(current.acceptedRevision,undefined);assert.match(current.diagnostics.at(-1)!.reason,/assignmentId/);f.db.close();
});
test('records admission, execution and acceptance failure categories without finishing',async()=>{
 for(const [state,category] of [['rejected','dispatch'],['failed','execution'],['completed','acceptance']] as const){const f=fixture(),c=f.make();const run=await c.start('t',{repository:'https://github.com/o/r',baseRevision:revision});f.updates.set(run.assignments[0].assignment.assignmentId,{state,artifacts:[]});await c.tick();const current=(await c.get('t'))!;assert.equal(current.phase,'escalated');assert.equal(current.diagnostics.at(-1)?.category,category);assert.notEqual(f.task().columnId,'done');f.db.close();}
});

test('cancel and retry preserve an accepted implementation while review admission is unavailable', async () => {
 const f = fixture(), c = f.make();
 f.setAgents([agents[0]]);
 const run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
 const a = run.assignments[0].assignment;
 await c.accept('t', clean(result(a, 'implementation')), a.endpointId);
 await c.cancel('t');
 assert.equal((await c.get('t'))?.assignments[0].state, 'accepted');
 f.setAgents(agents);
 assert.equal((await c.retry('t')).assignments[1].assignment.role, 'review');
 f.db.close();
});

test('retry resumes pending review without fencing accepted implementation or spending its last dispatch on implementation', async () => {
 const f = fixture(), c = f.make();
 f.setAgents([agents[0]]);
 const run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision, policy: { maxDispatches: 2 } });
 const a = run.assignments[0].assignment;
 await c.accept('t', clean(result(a, 'implementation')), a.endpointId);
 assert.equal((await c.get('t'))?.phase, 'escalated');
 f.setAgents(agents);
 const resumed = await f.make().retry('t');
 assert.equal(resumed.assignments[0].state, 'accepted');
 assert.equal(resumed.assignments[1].assignment.role, 'review');
 assert.equal(resumed.assignments[1].assignment.targetRevision, output);
 assert.equal(resumed.assignments[1].assignment.parentImplementationAssignmentId, a.assignmentId);
 const review = resumed.assignments[1].assignment;
 await c.accept('t', clean(result(review, 'review')), review.endpointId);
 assert.equal((await c.get('t'))?.phase, 'awaiting_approval');
 f.db.close();
});

test('cancellation projection is replayed after a write failure before ownership is released', async (t) => {
 const f = fixture(), c = f.make();
 await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
 const update = f.tasks.update;
 const mocked = t.mock.method(f.tasks, 'update', async () => { throw new Error('database unavailable'); });
 await assert.rejects(() => c.cancel('t'), /database unavailable/);
 assert.equal(await c.ownsTask('t'), true);
 mocked.mock.restore();
 await f.make().tick();
 assert.equal(f.task().agentStatus, 'idle');
 assert.equal(await f.make().ownsTask('t'), false);
 const writes = t.mock.method(f.tasks, 'update', update);
 await f.make().tick();
 assert.equal(writes.mock.callCount(), 0);
 f.db.close();
});

test('completed workflows do not rewrite completion timestamps on reconciliation', async (t) => {
 const f = fixture(), c = f.make();
 const run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
 const implementation = run.assignments[0].assignment;
 await c.accept('t', clean(result(implementation, 'implementation')), implementation.endpointId);
 const review = (await c.get('t'))!.assignments[1].assignment;
 await c.accept('t', clean(result(review, 'review')), review.endpointId);
 await c.approve('t', output);
 const writes = t.mock.method(f.tasks, 'update');
 await f.make().tick(); await f.make().tick();
 assert.equal(writes.mock.callCount(), 0);
 f.db.close();
});

test('cancellation releases projection after its durable checkpoint and late results cannot clobber legacy work', async () => {
 const f = fixture(), c = f.make();
 const run = await c.start('t', { repository: 'https://github.com/o/r', baseRevision: revision });
 await c.cancel('t');
 await f.tasks.update('t', { columnId: 'in-progress', agentStatus: 'executing', summary: 'legacy run' });
 await f.make().tick();
 await f.make().accept('t', clean(result(run.assignments[0].assignment, 'implementation')), 'implementer');
 assert.equal(f.task().columnId, 'in-progress');
 assert.equal(f.task().agentStatus, 'executing');
 assert.equal(f.task().summary, 'legacy run');
 f.db.close();
});
