import assert from 'node:assert/strict';import test from 'node:test';import http from 'node:http';import {createHash} from 'node:crypto';
import { verifyExecutionEvidence } from '../src/services/execution-evidence.js';
test('result-supplied evidence cannot fetch an unrelated public or private HTTPS origin', async (t) => {
 const targets: string[] = [];
 t.mock.method(globalThis, 'fetch', async (url: URL) => { targets.push(String(url)); return new Response('unauthorized content'); });
 for (const artifact of ['https://127.0.0.1:9443/admin', 'https://other.example/output', 'https://worker.example:9443/output', 'https://user:password@worker.example/output']) {
  await assert.rejects(() => verifyExecutionEvidence({ evidence: [{ artifact }] } as any, 'https://worker.example/a2a/v1'), /unsafe evidence artifact URL/);
 }
 assert.deepEqual(targets, []);
});

test('acceptance retrieves content-addressed evidence and refuses missing or mismatched artifacts',async()=>{
 const content='actual test output',hash=createHash('sha256').update(content).digest('hex');const server=http.createServer((req,res)=>{if(req.url==='/artifacts/'+hash)res.end(content);else{res.statusCode=404;res.end('missing');}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(server.address() as any).port}/a2a/v1`;
 try{await verifyExecutionEvidence({evidence:[{artifact:'urn:sha256:'+hash}]} as any,endpoint);await assert.rejects(()=>verifyExecutionEvidence({evidence:[{artifact:'urn:sha256:'+'a'.repeat(64)}]} as any,endpoint),/artifact/);await assert.rejects(()=>verifyExecutionEvidence({evidence:[{artifact:'http://public.example/file'}]} as any,endpoint),/artifact/);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
