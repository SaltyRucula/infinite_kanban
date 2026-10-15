import {test,expect} from '@playwright/test';import {createHash} from 'node:crypto';import http from 'node:http';import {API} from './helpers';
test('board workflow hands off pinned review, shows evidence and requires human approval in browser',async({page,request})=>{
 const revision='a'.repeat(40),output='b'.repeat(40);const peers:http.Server[]=[];
 try{
 for(const role of ['implementation','review']){
 const tasks=new Map<string,any>();const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.url?.startsWith('/artifacts/')){res.end('fixture evidence');return;}if(req.url==='/.well-known/agent-card.json'){res.end(JSON.stringify({name:role,description:'Deterministic native A2A test endpoint',version:'1',supportedInterfaces:[{url:`http://127.0.0.1:${(server.address() as any).port}/a2a/v1`,protocolBinding:'JSONRPC',protocolVersion:'1.0'}],skills:[{id:role,name:role,tags:['execution:v1','repository:github.com/o/r','consent:default','review:snapshot']}]}));return;}let body='';for await(const chunk of req)body+=chunk;const rpc=JSON.parse(body);if(rpc.method==='SendMessage'){const a=rpc.params.message.parts.find((p:any)=>p.data).data;const r={schemaVersion:1,taskId:a.taskId,workflowRunId:a.workflowRunId,assignmentId:a.assignmentId,attempt:a.attempt,role:a.role,endpointId:a.endpointId,revision:output,summary:'Fixture evidence',evidence:[{check:'fixture',revision:output,outcome:'passed',artifact:'urn:sha256:'+createHash('sha256').update('fixture evidence').digest('hex')}],...(role==='review'?{verdict:'approved',findings:[]}:{})};tasks.set(a.assignmentId,{id:a.assignmentId,status:{state:'TASK_STATE_COMPLETED'},artifacts:[{artifactId:'result',parts:[{data:r}]}]});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:tasks.get(a.assignmentId)}));}else res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:tasks.get(rpc.params.id)}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));peers.push(server);
 const registration=await request.post(API+'/api/a2a-agents',{data:{agentCardUrl:`http://127.0.0.1:${(server.address() as any).port}/.well-known/agent-card.json`}});expect(registration.status()).toBe(201);const agent=await registration.json();expect((await request.put(API+`/api/a2a-agents/${agent.id}/projects/default/roles`,{data:{roles:[role]}})).ok()).toBeTruthy();
 }
 const response=await request.post(API+'/api/tasks',{data:{title:'Board workflow approval fixture'}});const task=await response.json();
 await page.goto('/');await page.getByText(task.title,{exact:true}).click();await page.getByText('Board-owned workflow',{exact:true}).click();await page.getByLabel('Workflow repository').fill('https://github.com/o/r');await page.getByLabel('Base revision').fill(revision);await page.getByRole('button',{name:'Start implementation → review'}).click();
 await expect(page.getByText('awaiting_approval',{exact:true})).toBeVisible({timeout:15000});await expect(page.getByText(output,{exact:true}).first()).toBeVisible();
 // A board-owned workflow must not offer legacy worker controls: they target a
 // different execution model and the server correctly rejects them.
 await expect(page.locator('button:visible').filter({hasText:'Run Agent'})).toHaveCount(0);
 await expect(page.locator('button:visible').filter({hasText:/Worker:/})).toHaveCount(0);
 await expect(page.locator('button:visible').filter({hasText:'OpenCode'})).toHaveCount(0);
 const run=await(await request.get(API+`/api/tasks/${task.id}/workflow`)).json();expect(run.assignments[1].assignment.targetRevision).toBe(output);expect(run.assignments[1].assignment.endpointId).not.toBe(run.assignments[0].assignment.endpointId);
 expect((await request.post(API+`/api/tasks/${task.id}/workflow/approve`,{data:{revision}})).status()).toBe(409);
 await page.getByRole('button',{name:'Approve reviewed revision'}).click();await expect(page.getByText('done',{exact:true})).toBeVisible();expect((await(await request.get(API+'/api/tasks')).json()).find((t:any)=>t.id===task.id).columnId).toBe('done');
 }finally{for(const peer of peers)await new Promise<void>(r=>peer.close(()=>r()));}
});
