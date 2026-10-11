import {validateAssignment,type ExecutionAssignment,type ExecutionResult} from '@ai-agent-board/shared/execution.js';
/** Native A2A v1 JSON data mapping, usable by non-board endpoints as well. */
export function executionParts(assignment:ExecutionAssignment) {const value=validateAssignment(assignment);return [{text:value.requirements},{data:value}];}
export function executionArtifacts(result:ExecutionResult) {return [{artifactId:`${result.assignmentId}-result`,name:'execution-result-v1',parts:[{data:result}]}];}
export function resultFromArtifacts(artifacts:readonly unknown[]):unknown {
 const results=artifacts.flatMap((a:any)=>Array.isArray(a?.parts)?a.parts.filter((p:any)=>p.data!==undefined).map((p:any)=>p.data):[]);
 if(results.length!==1)throw new Error('completed task must contain exactly one structured result');
 return results[0];
}
