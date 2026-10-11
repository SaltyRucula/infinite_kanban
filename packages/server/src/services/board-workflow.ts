import { executionParts, resultFromArtifacts } from '@ai-agent-board/a2a/execution.js';
import { verifyExecutionEvidence } from './execution-evidence.js';
import type { ExecutionResult } from '@ai-agent-board/shared/execution.js';
import { randomUUID } from 'node:crypto';
import { immutableRevision, strictRecord, validateAssignment, validateResult, type ExecutionRole } from '@ai-agent-board/shared/execution.js';
import type { TaskRepository } from '../repositories/types.js';
import type { A2AAgentRepository } from '../repositories/a2a-agent-types.js';
import type { BoardWorkflowRun, WorkflowDispatch, WorkflowStore } from '../repositories/workflow-store.js';
import { JsonRpcA2AExecutor, negotiateProtocolVersion, type A2ARemoteProgress } from './a2a-workflow-client.js';
import { normalizeRepoUrl } from '../routes/helpers.js';
import { broadcastTaskUpdate } from '../routes/helpers.js';
/** A workflow decision, relayed to the task's event log so a run is never silent. */
export interface WorkflowEvent { taskId: string; type: 'thinking'|'tool_call'|'file_read'|'file_write'|'file_edit'|'command'|'command_output'|'output'|'test_result'|'error'|'complete'; content: string; metadata?: Record<string,unknown> }
/** Progress kinds an endpoint may claim; anything else is shown as plain output. */
const PROGRESS_TYPES=new Set<WorkflowEvent['type']>(['thinking','tool_call','file_read','file_write','file_edit','command','command_output','output','test_result']);
/** Matches the endpoint's own history cap, so the dedupe window covers it. */
const MAX_RELAYED=200;
export interface StartWorkflow { repository: string; baseRevision: string; requiredCapabilities?: string[]; policy?: Partial<BoardWorkflowRun['policy']> }
type Executor = Pick<JsonRpcA2AExecutor,'dispatch'|'getUpdate'|'cancel'>;
/** A durable state machine. Persist send intent BEFORE IO; crashes never blindly resend it. */
export class BoardWorkflowCoordinator {
 private locks = new Map<string,Promise<unknown>>();
 constructor(private store: WorkflowStore, private tasks: Pick<TaskRepository,'getById'|'update'>, private agents: Pick<A2AAgentRepository,'getAll'>, private executor: (d:WorkflowDispatch)=>Executor = d=>new JsonRpcA2AExecutor(d.endpoint,{protocolVersion:d.protocolVersion,maxRetries:0}), private verifyEvidence:(result:ExecutionResult,endpoint:string)=>Promise<void>=verifyExecutionEvidence, private emit?:(event:WorkflowEvent)=>void) {}

 /**
  * Record what the workflow just decided on the task's own event log.
  *
  * Without this a failed run reaches the board with no events at all, and the
  * panel can only say it has nothing to show. The sink is best-effort: a
  * broken event log must never take the workflow down with it.
  */
 private record(taskId:string,type:WorkflowEvent['type'],content:string,metadata?:Record<string,unknown>) {
  if(!this.emit || !content) return;
  try { this.emit({taskId,type,content,...(metadata?{metadata}:{})}); } catch { /* advisory only */ }
 }
 private async locked<T>(id:string, fn:()=>Promise<T>):Promise<T> {const previous=this.locks.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(fn);this.locks.set(id,next);try{return await next;}finally{if(this.locks.get(id)===next)this.locks.delete(id);}}
 get(id:string) {return this.store.get(id);}
 async ownsTask(id: string): Promise<boolean> {
  const run = await this.store.get(id);
  return Boolean(run && (run.phase !== 'canceled' || run.projectedPhase !== 'canceled'));
 }
 private save(run:BoardWorkflowRun) {return this.store.save(run,run.version);}
 async start(id:string,input:StartWorkflow) {return this.locked(id,async()=>{
  strictRecord(input,['repository','baseRevision','requiredCapabilities','policy']);immutableRevision(input.baseRevision);
  if(await this.store.get(id))throw new Error('workflow already exists; cancel/reconcile the existing run');
  const task=await this.tasks.getById(id);if(!task)throw new Error('task not found');
  if(task.groupId || task.assignedWorkerId || task.runRequestedAt || ['planning','executing'].includes(task.agentStatus) || task.columnId==='done' || task.archived)throw new Error('task is not eligible for workflow');
  const policy={autoFinish:false,maxRounds:3,maxDispatches:6,deadline:Date.now()+3600000,requiredChecks:[],...input.policy};
  strictRecord(policy,['autoFinish','maxRounds','maxDispatches','deadline','requiredChecks']);
  if(typeof policy.autoFinish!=='boolean' || !Number.isInteger(policy.maxRounds) || policy.maxRounds<1 || policy.maxRounds>20 || !Number.isInteger(policy.maxDispatches) || policy.maxDispatches<2 || policy.maxDispatches>40 || !Number.isSafeInteger(policy.deadline) || policy.deadline<=Date.now() || !Array.isArray(policy.requiredChecks) || policy.requiredChecks.some(c=>typeof c!=='string'||!c))throw new Error('invalid workflow policy');
  const run:BoardWorkflowRun={id:randomUUID(),taskId:id,projectId:task.projectId,version:0,phase:'implementing',repository:input.repository,baseRevision:input.baseRevision,requirements:`${task.title}\n\n${task.description}`,requiredCapabilities:input.requiredCapabilities??[],policy,assignments:[],diagnostics:[]};
  // Validate BEFORE persistence, even if no endpoint is available.
  validateAssignment({schemaVersion:1,taskId:id,projectId:run.projectId,workflowRunId:run.id,assignmentId:'validation',attempt:1,role:'implementation',endpointId:'validation',repository:run.repository,baseRevision:run.baseRevision,requirements:run.requirements,requiredCapabilities:run.requiredCapabilities,constraints:{deadline:policy.deadline}});
  await this.save(run);await this.dispatch(run,'implementation');await this.project(run);return run;
 });}
 private async project(run:BoardWorkflowRun) {
  // The projection is a pure function of these; rewriting the task when none
  // of them moved broadcast duplicate state on every tick, forever, and buried
  // the event feed under it.
  const key=`${run.phase}|${run.diagnostics.length}|${run.diagnostics.at(-1)?.reason??''}|${run.acceptedRevision??''}|${run.approvedRevision??''}`;
  if (run.projectedKey === key) return;
  if (['canceled', 'done'].includes(run.phase) && run.projectedPhase === run.phase) return;
  const complete=run.phase==='done';const review=run.phase==='reviewing'||run.phase==='awaiting_approval';
  const task=await this.tasks.update(run.taskId,{columnId:complete?'done':review?'review':run.phase==='canceled'?'backlog':'in-progress',agentStatus:complete||run.phase==='awaiting_approval'?'complete':run.phase==='escalated'||run.phase==='dispatch_uncertain'?'failed':run.phase==='canceled'?'idle':'executing',summary:`Workflow ${run.phase}${run.diagnostics.length?': '+run.diagnostics.at(-1)!.reason:''}`,completedAt:complete?Date.now():undefined});if(task) {
   broadcastTaskUpdate(task);
   if (run.projectedPhase !== run.phase || run.projectedKey !== key) { run.projectedPhase = run.phase; run.projectedKey = key; await this.save(run); }
  }
 }
 private async dispatch(run:BoardWorkflowRun,role:ExecutionRole) {
  if(run.assignments.length>=run.policy.maxDispatches || Date.now()>=run.policy.deadline){await this.escalate(run,'dispatch','workflow dispatch/deadline limit exhausted');return;}
  const implementation=[...run.assignments].reverse().find(d=>d.assignment.role==='implementation'&&d.result);
  const candidates=(await this.agents.getAll()).filter(agent=>{
   const tags=agent.skills.flatMap(s=>s.tags);
   return agent.enabled && agent.projectAccess.some(p=>p.projectId===run.projectId&&p.roles.includes(role)) && ['execution:v1',`repository:${normalizeRepoUrl(run.repository)}`,`consent:${run.projectId}`,...run.requiredCapabilities,...(role==='review'?['review:snapshot']:[])].every(t=>tags.includes(t)) && (role!=='review'||(agent.id!==implementation?.assignment.endpointId && agent.endpoint!==implementation?.endpoint));
  });
  const endpoint=candidates[0];if(!endpoint){await this.escalate(run,'dispatch',`no eligible ${role==='review'?'distinct review':'implementation'} endpoint with repository access and consent`);return;}
  const assignment=validateAssignment({schemaVersion:1,taskId:run.taskId,projectId:run.projectId,workflowRunId:run.id,assignmentId:randomUUID(),attempt:run.assignments.length+1,role,endpointId:endpoint.id,repository:run.repository,baseRevision:run.acceptedRevision??run.baseRevision,requirements:run.requirements,requiredCapabilities:run.requiredCapabilities,constraints:{deadline:run.policy.deadline,...(role==='review'?{readOnly:true}:{})},...(role==='review'?{targetRevision:run.acceptedRevision,parentImplementationAssignmentId:implementation?.assignment.assignmentId}:{})});
  const d:WorkflowDispatch={assignment,endpoint:endpoint.endpoint,protocolVersion:negotiateProtocolVersion(endpoint.protocolVersion),state:'sending'};
  run.assignments.push(d);run.phase=role==='review'?'reviewing':'implementing';await this.save(run);
  try {const receipt=await this.executor(d).dispatch({message:{role:'ROLE_USER',messageId:assignment.assignmentId,parts:executionParts(assignment)},metadata:{'infinite_kanban.execution':1}});d.remoteTaskId=receipt.remoteTaskId;d.state='running';this.record(run.taskId,'tool_call',`Assigned ${role} attempt ${assignment.attempt} to ${endpoint.name||endpoint.id}`,{role,attempt:assignment.attempt,endpointId:endpoint.id,assignmentId:assignment.assignmentId});await this.save(run);}
  catch {run.phase='dispatch_uncertain';run.diagnostics.push({at:Date.now(),category:'dispatch',reason:'uncertain dispatch; reconcile existing assignment, never blindly resend'});this.record(run.taskId,'error',`Dispatch of ${role} attempt ${assignment.attempt} to ${endpoint.name||endpoint.id} is uncertain; reconcile the existing assignment before resending`,{role,endpointId:endpoint.id});await this.save(run);}
 }
 private async escalate(run:BoardWorkflowRun,category:'dispatch'|'execution'|'acceptance',reason:string,response?:unknown) {run.phase='escalated';run.diagnostics.push({at:Date.now(),category,reason,...(response===undefined?{}:{response})});this.record(run.taskId,'error',`Workflow escalated during ${category}: ${reason}`,{category,phase:'escalated'});await this.save(run);}
 async accept(id:string,response:unknown,endpointId:string) {return this.locked(id,async()=>{const run=await this.store.get(id);if(!run)throw new Error('workflow not found');await this.settle(run,response,endpointId);await this.project(run);return run;});}
 private async settle(run:BoardWorkflowRun,response:unknown,endpointId:string) {
  // Exact accepted duplicates remain idempotent after handoff and restart.
  if(run.assignments.some(d=>d.result && d.assignment.endpointId===endpointId && JSON.stringify(d.result)===JSON.stringify(response)))return;
  const d=run.assignments.at(-1);
  try {
   if(!d || ['canceled','done','awaiting_approval','escalated'].includes(run.phase) || d.state==='fenced' || d.state==='accepted')throw new Error('late/fenced result');
   if(endpointId!==d.assignment.endpointId)throw new Error('wrong producing endpoint');
   const result=validateResult(response,d.assignment);
   for(const check of run.policy.requiredChecks)if(!result.evidence.some(e=>e.check===check&&e.outcome==='passed'))throw new Error(`missing passing required check: ${check}`);
   await this.verifyEvidence(result,d.endpoint);
   d.result=result;d.state='accepted';
   const checks=result.evidence.map(e=>`${e.check}: ${e.outcome}`).join(', ');
   this.record(run.taskId,result.role==='review'?'test_result':'output',`Accepted ${result.role} of ${result.revision.slice(0,12)}${result.verdict?` — verdict ${result.verdict}`:''}${checks?` (${checks})`:''}`,{role:result.role,revision:result.revision,...(result.verdict?{verdict:result.verdict}:{})});
   if(result.findings?.length)this.record(run.taskId,'output',`Review findings:\n${result.findings.map(f=>`- [${f.severity}] ${f.location?`${f.location}: `:''}${f.explanation}`).join('\n')}`,{role:'review'});
   if(result.role==='implementation') {run.acceptedRevision=result.revision;delete run.approvedRevision;delete run.approvedBy;delete run.approvedAt;await this.save(run);await this.dispatch(run,'review');}
   else if(result.verdict==='approved') {run.phase=run.policy.autoFinish?'done':'awaiting_approval';await this.save(run);}
   else {const rounds=run.assignments.filter(a=>a.assignment.role==='review').length;if(rounds>=run.policy.maxRounds){await this.escalate(run,'acceptance','review round limit exhausted');return;}run.requirements+=`\n\nReview findings for ${result.revision}:\n${JSON.stringify(result.findings)}`;await this.save(run);await this.dispatch(run,'implementation');}
  } catch(error) {const reason=error instanceof Error?error.message:'invalid response';const late=reason==='late/fenced result'||reason==='wrong producing endpoint'||/does not match active dispatch/.test(reason);run.diagnostics.push({at:Date.now(),category:'acceptance',reason,response});if(!late)run.phase='escalated';this.record(run.taskId,'error',`Result refused during acceptance: ${reason}`,{category:'acceptance',late});await this.save(run);}
 }
 async approve(id:string,revision:string,actor='board-operator') {return this.locked(id,async()=>{const run=await this.store.get(id);if(!run || run.phase!=='awaiting_approval'||run.acceptedRevision!==revision)throw new Error('approval must match awaiting revision');run.approvedRevision=revision;run.approvedBy=actor;run.approvedAt=Date.now();run.phase='done';this.record(run.taskId,'complete',`Approved ${revision.slice(0,12)} by ${actor}`,{revision,actor});await this.save(run);await this.project(run);return run;});}
 async cancel(id:string) {return this.locked(id,async()=>{const run=await this.store.get(id);if(!run)throw new Error('workflow not found');if(run.phase==='done')throw new Error('completed workflow cannot be canceled');run.phase='canceled';this.record(run.taskId,'output','Workflow canceled; the active assignment is fenced',{phase:'canceled'});const d=run.assignments.at(-1);if(d && !d.result)d.state='fenced';await this.save(run);await this.project(run);if(d?.remoteTaskId && !d.result)try{await this.executor(d).cancel(d.remoteTaskId);}catch{run.diagnostics.push({at:Date.now(),category:'dispatch',reason:'cancel fenced locally; remote cancellation unconfirmed'});await this.save(run);}return run;});}
 async retry(id:string) {return this.locked(id,async()=>{const run=await this.store.get(id);if(!run || !['canceled','escalated'].includes(run.phase))throw new Error('cancel or resolve the existing dispatch before retry');if(run.diagnostics.some(d=>/round limit|dispatch\/deadline limit/.test(d.reason)))throw new Error('workflow limits exhausted');const task=await this.tasks.getById(id);if(!task || task.assignedWorkerId || task.runRequestedAt || task.archived || (run.phase==='canceled'&&['planning','executing'].includes(task.agentStatus)))throw new Error('task is not eligible for retry');const previous=run.assignments.at(-1);const role=previous?.result ? (previous.result.role==='implementation'?'review':'implementation') : previous?.assignment.role??'implementation';if(previous && !previous.result)previous.state='fenced';delete run.approvedRevision;delete run.approvedBy;delete run.approvedAt;await this.save(run);await this.dispatch(run,role);await this.project(run);return run;});}
 /**
  * Relay endpoint progress to the task's event log, exactly once per message.
  *
  * The relayed ids are persisted with the dispatch, so a restarted coordinator
  * resumes where it left off instead of replaying the backlog into the panel.
  * The list is capped to match the endpoint's own history bound.
  */
 private async relayProgress(run:BoardWorkflowRun,d:WorkflowDispatch,history?:readonly A2ARemoteProgress[]) {
  if(!this.emit || !history?.length) return;
  const relayed=new Set(d.relayed??[]);
  const fresh=history.filter(entry=>!relayed.has(entry.messageId));
  if(!fresh.length) return;
  for(const entry of fresh)this.record(run.taskId,PROGRESS_TYPES.has(entry.kind as WorkflowEvent['type'])?entry.kind as WorkflowEvent['type']:'output',entry.text,{role:d.assignment.role,assignmentId:d.assignment.assignmentId});
  d.relayed=[...relayed,...fresh.map(entry=>entry.messageId)].slice(-MAX_RELAYED);
  await this.save(run);
 }
 async tick() {for(const entry of await this.store.list())await this.locked(entry.taskId,async()=>{
  const run=(await this.store.get(entry.taskId))!;await this.project(run);const d=run.assignments.at(-1);
  if(['done','canceled','awaiting_approval','escalated'].includes(run.phase))return;
  if(!d){await this.dispatch(run,'implementation');await this.project(run);return;}
  if(d.state==='accepted'){await this.dispatch(run,d.assignment.role==='implementation'?'review':'implementation');return;}
  if(Date.now()>=run.policy.deadline){d.state='fenced';await this.escalate(run,'execution','workflow deadline expired');await this.project(run);return;}
  try {const update=await this.executor(d).getUpdate(d.remoteTaskId??d.assignment.assignmentId);
   await this.relayProgress(run,d,update.history);
   if(update.state==='completed'){let result:unknown;try{result=resultFromArtifacts(update.artifacts);}catch{await this.escalate(run,'acceptance','completed task must contain exactly one structured result',update);return;}await this.settle(run,result,d.assignment.endpointId);}
   else if(update.state==='rejected'){await this.escalate(run,'dispatch','endpoint refused assignment admission',update);}
   else if(update.state==='failed'||update.state==='canceled'||update.state==='input_required'){await this.escalate(run,'execution',`endpoint execution ${update.state}`,update);}
   else {d.state='running';d.remoteTaskId??=d.assignment.assignmentId;run.phase=d.assignment.role==='review'?'reviewing':'implementing';await this.save(run);}
   await this.project(run);
  }catch { /* uncertain send/poll remains durable; no automatic redispatch */ }
 });}
}
