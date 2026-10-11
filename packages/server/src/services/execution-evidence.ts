import { createHash } from 'node:crypto';
import { isAllowedA2AUrl } from '@ai-agent-board/a2a/cards.js';
import type { ExecutionResult } from '@ai-agent-board/shared/execution.js';
/** urn:sha256 evidence resolves against the producing endpoint's artifact resource. */
export async function verifyExecutionEvidence(result:ExecutionResult,endpoint:string):Promise<void> {
 const producingEndpoint = new URL(endpoint);
 if (!isAllowedA2AUrl(producingEndpoint) || producingEndpoint.username || producingEndpoint.password) throw new Error('unsafe evidence artifact URL');
 for(const evidence of result.evidence) {
  const hash=evidence.artifact.match(/^urn:sha256:([a-f0-9]{64})$/)?.[1];
  const url=hash?new URL(`/artifacts/${hash}`,endpoint):new URL(evidence.artifact);
  if(!isAllowedA2AUrl(url)||url.origin !== producingEndpoint.origin||url.username||url.password)throw new Error('unsafe evidence artifact URL');
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok||!response.body)throw new Error('evidence artifact unavailable');
  const chunks:Uint8Array[]=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024){await response.body.cancel().catch(()=>{});throw new Error('evidence artifact exceeds size limit');}chunks.push(chunk);}
  if(hash&&createHash('sha256').update(Buffer.concat(chunks)).digest('hex')!==hash)throw new Error('evidence artifact digest mismatch');
 }
}
