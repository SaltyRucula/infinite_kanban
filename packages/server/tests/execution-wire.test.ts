import assert from 'node:assert/strict';import test from 'node:test';
import { JsonRpcA2AExecutor } from '../src/services/a2a-workflow-client.js';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, UnauthenticatedUser } from '@a2a-js/sdk/server';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { TaskState } from '@a2a-js/sdk';
import { boardAgentCard } from '@ai-agent-board/a2a/cards.js';
test('dispatch interoperates with the official SDK v1 server before execution completes', async () => {
 let release!: () => void;
 const completion = new Promise<void>((resolve) => { release = resolve; });
 const store = new InMemoryTaskStore();
 const handler = new DefaultRequestHandler(
  boardAgentCard({ baseUrl: 'http://localhost', version: 'test', authRequired: false }),
  store,
  {
   execute: async (context, bus) => {
    bus.publish(AgentEvent.task({ id: context.taskId, contextId: context.contextId, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined }, artifacts: [], history: [], metadata: undefined }));
    await completion;
    bus.publish(AgentEvent.task({ id: context.taskId, contextId: context.contextId, status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined }, artifacts: [], history: [], metadata: undefined }));
    bus.finished();
   },
   cancelTask: async () => { release(); },
  },
 );
 const app = express(); app.use(express.json()); app.use('/a2a/v1', jsonRpcHandler({ requestHandler: handler, userBuilder: async () => new UnauthenticatedUser() }));
 const server = createServer(app);
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
 try {
  const executor = new JsonRpcA2AExecutor(`http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a/v1`, { maxRetries: 0, timeoutMs: 1000 });
  const receipt = await executor.dispatch({ message: { role: 'ROLE_USER', messageId: 'official-sdk-interop', parts: [{ text: 'Execute slowly' }] }, metadata: {} });
  assert.ok(receipt.remoteTaskId);
  assert.equal((await executor.getUpdate(receipt.remoteTaskId)).state, 'running');
 } finally {
  release();
  await new Promise<void>((resolve) => server.close(() => resolve()));
 }
});

test('carries structured execution data in v1 parts without text coercion',async()=>{
 let body:any;const e=new JsonRpcA2AExecutor('http://localhost:4000/a2a/v1',{maxRetries:0,fetcher:async(_url,init)=>{body=JSON.parse(String(init.body));return new Response(JSON.stringify({jsonrpc:'2.0',id:'assignment',result:{task:{id:'assignment',status:{state:'TASK_STATE_WORKING'}}}}));}});
 await e.dispatch({message:{role:'ROLE_USER',messageId:'assignment',parts:[{data:{schemaVersion:1,taskId:'t'}} as any]},metadata:{}});
 assert.deepEqual(body.params.configuration, { returnImmediately: true });
 assert.deepEqual(body.params.message.parts,[{data:{schemaVersion:1,taskId:'t'}}]);
 const refused=new JsonRpcA2AExecutor('http://localhost:4000/a2a/v1',{maxRetries:0,fetcher:async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:'get:refused',result:{id:'refused',status:{state:'TASK_STATE_REJECTED'}}}))});
 assert.equal((await refused.getUpdate('refused')).state,'rejected');
});
