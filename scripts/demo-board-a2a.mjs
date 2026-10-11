#!/usr/bin/env node
/** REAL A2A demo: board owns handoff. No worker poll/claim or prose settlement. */
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import net from 'node:net';import {fileURLToPath} from 'node:url';
import {startExecutionEndpoint} from '../packages/worker/dist/execution-endpoint.js';
const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const implementation=process.env.DEMO_IMPLEMENTATION_HARNESS??'opencode',review=process.env.DEMO_REVIEW_HARNESS??'codex';
if(!['opencode','codex'].includes(implementation)||!['opencode','codex'].includes(review))throw new Error('Supported genuine harnesses: opencode, codex');
const root=await mkdtemp(path.join(process.env.TMPDIR??path.join(repoRoot,'.scratch'),'board-a2a-demo-'));const fixture=path.join(root,'fixture');await mkdir(fixture);
const git=(...args)=>execFileSync('git',args,{cwd:fixture,stdio:['ignore','pipe','pipe']}).toString().trim();
git('init','-b','main');git('config','user.name','A2A demo');git('config','user.email','demo@localhost');
await writeFile(path.join(fixture,'add.cjs'),'module.exports = (a,b) => a - b;\n');
await writeFile(path.join(fixture,'add.test.cjs'),"const test=require('node:test'),assert=require('node:assert/strict'),add=require('./add.cjs');test('adds positive and negative values',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1)});\n");
git('add','.');git('commit','-m','demo fixture');const baseRevision=git('rev-parse','HEAD');const repository='https://github.com/board-demo/add';
const freePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;};
const port=await freePort();const base=`http://127.0.0.1:${port}`;let board;const endpoints=[];
const api=async(url,method='GET',data)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const text=await response.text();if(!response.ok)throw new Error(`${method} ${url}: ${response.status} ${text}`);return JSON.parse(text);};
const report={artifactDirectory:root,implementationHarness:implementation,reviewHarness:review,baseRevision,repository};
try {
 const logPath=path.join(root,'board.log');const {open}=await import('node:fs/promises');const log=await open(logPath,'w');
 board=spawn(process.execPath,['dist/index.js'],{cwd:path.join(repoRoot,'packages/server'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATABASE_URL:'',API_KEY:'',SERVICE_TOKENS:'',DB_PATH:path.join(root,'board.db'),AGENTBOARD_HOME:path.join(root,'board-home'),DOTENV_CONFIG_PATH:path.join(root,'no-env'),AGENTBOARD_DISABLE_AGENT_STARTUP:'1'},stdio:['ignore',log.fd,log.fd]});await log.close();
 for(let i=0;i<100;i++){try{await api('/api/health');break;}catch{if(i===99)throw new Error(`fresh built board failed to start; ${logPath}`);await new Promise(r=>setTimeout(r,100));}}
 for(const [role,harness] of [['implementation',implementation],['review',review]]){
  const config={harness,model:harness==='opencode'?(process.env.DEMO_OPENCODE_MODEL??'github-copilot/gpt-6.1-sol'):process.env.DEMO_CODEX_MODEL,roles:[role],projects:['default'],repositories:{[repository]:fixture},stateDirectory:path.join(root,role),capabilities:['git:revision'],checks:[{name:'node-tests',command:process.execPath,args:['--test','add.test.cjs']}]};
  const endpoint=await startExecutionEndpoint(config,{port:0});endpoints.push(endpoint);const registration=await api('/api/a2a-agents','POST',{agentCardUrl:endpoint.baseUrl+'/.well-known/agent-card.json'});await api(`/api/a2a-agents/${registration.id}/projects/default/roles`,'PUT',{roles:[role]});
 }
 const task=await api('/api/tasks','POST',{title:'Fix integer addition',description:'Correct add.cjs to add two numbers. Preserve CommonJS exports and pass the existing node:test fixture. Only change add.cjs.'});report.taskId=task.id;
 await api(`/api/tasks/${task.id}/workflow/run`,'POST',{repository,baseRevision,requiredCapabilities:['git:revision'],policy:{requiredChecks:['node-tests'],deadline:Date.now()+600000}});
 let run;
 for(let i=0;i<600;i++){run=await api(`/api/tasks/${task.id}/workflow`);if(['awaiting_approval','done','escalated','canceled'].includes(run.phase))break;await new Promise(r=>setTimeout(r,1000));}
 report.workflow=run;await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
 if(run.phase!=='awaiting_approval')throw new Error(`workflow ended ${run.phase}: ${JSON.stringify(run.diagnostics)}. No synthetic fallback. Evidence: ${root}`);
 if(run.assignments[1].assignment.targetRevision!==run.acceptedRevision)throw new Error('review subject mismatch');
 await api(`/api/tasks/${task.id}/workflow/approve`,'POST',{revision:run.acceptedRevision});report.workflow=await api(`/api/tasks/${task.id}/workflow`);report.task=(await api('/api/tasks')).find(t=>t.id===task.id);if(report.task.columnId!=='done')throw new Error('board approval did not finish');
 await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{for(const endpoint of endpoints)await endpoint.close();if(board&&!board.killed){board.kill('SIGTERM');await new Promise(r=>board.once('exit',r));}}
