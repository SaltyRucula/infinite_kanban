import { useEffect, useState } from 'react';
import { workflowApi, type WorkflowView } from '@/lib/api';

interface WorkflowPanelProps {
 taskId: string;
 /** Lets surrounding task controls hide the incompatible legacy execution path. */
 onOwnershipChange?: (owned: boolean) => void;
}

/** Board-owned controls deliberately have no harness/model selector. */
export function WorkflowPanel({taskId,onOwnershipChange}:WorkflowPanelProps) {
 const [run,setRun]=useState<WorkflowView|null>(null),[repository,setRepository]=useState(''),[revision,setRevision]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let mounted=true;const load=async()=>{try{const result=await workflowApi.get(taskId);if(mounted){setRun(result);onOwnershipChange?.(true);}}catch(e){if(!mounted)return;if(e instanceof Error&&e.message==='workflow not found'){setRun(null);onOwnershipChange?.(false);return;}setError(String(e));}};void load();const timer=setInterval(()=>void load(),1000);return()=>{mounted=false;clearInterval(timer);};},[taskId,onOwnershipChange]);
 const action=async(operation:()=>Promise<WorkflowView>)=>{setBusy(true);setError('');try{const result=await operation();setRun(result);onOwnershipChange?.(true);}catch(e){setError(e instanceof Error?e.message:'Workflow request failed');}finally{setBusy(false);}};
 return <details className="shrink-0 border-b border-border p-3 text-xs" open={run!==null}>
  <summary className="cursor-pointer font-semibold">Board-owned workflow</summary>
  {error&&<p role="alert" className="text-red-500">{error}</p>}
  {!run?<div className="space-y-2 pt-2"><label className="block">Workflow repository<input aria-label="Workflow repository" className="block w-full rounded border p-1" value={repository} onChange={e=>setRepository(e.target.value)} placeholder="https://host/owner/repository" /></label><label className="block">Base revision<input aria-label="Base revision" className="block w-full rounded border p-1" value={revision} onChange={e=>setRevision(e.target.value)} placeholder="Immutable commit SHA" /></label><button disabled={busy||!repository||!revision} className="rounded border px-2 py-1" onClick={()=>void action(()=>workflowApi.start(taskId,{repository,baseRevision:revision}))}>Start implementation → review</button><p>Endpoints choose their harness. Human approval is required by default.</p></div>:<div className="max-h-60 space-y-2 overflow-auto pt-2">
   <p>Workflow state: <strong>{run.phase}</strong></p><p className="break-all">Run: {run.id}</p>
   {run.acceptedRevision&&<p className="break-all">Accepted revision: <span>{run.acceptedRevision}</span></p>}
   {run.assignments.map(d=><div key={d.assignment.assignmentId} className="rounded border p-2"><p>{d.assignment.role} · attempt {d.assignment.attempt} · {d.state}</p><p className="break-all">Endpoint: {d.assignment.endpointId}</p><p className="break-all">Assignment: {d.assignment.assignmentId}</p>{d.result&&<><p>{d.result.summary}</p>{d.result.verdict&&<p>Verdict: {d.result.verdict}</p>}{d.result.evidence.map((e,i)=><p key={i}>{e.check}: {e.outcome}</p>)}</>}</div>)}
   {run.diagnostics.map((d,i)=><p key={i} role="status">{d.category}: {d.reason}</p>)}
   {run.phase==='awaiting_approval'&&run.acceptedRevision&&<button disabled={busy} className="rounded border px-2 py-1" onClick={()=>void action(()=>workflowApi.approve(taskId,run.acceptedRevision!))}>Approve reviewed revision</button>}
   {!['done','canceled'].includes(run.phase)&&<button disabled={busy} className="ml-2 rounded border px-2 py-1" onClick={()=>void action(()=>workflowApi.cancel(taskId))}>Cancel workflow</button>}
  </div>}
 </details>;
}
