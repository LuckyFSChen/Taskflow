import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore,id} from '../server/db.js';
import {createTask,resultJson} from '../server/domain.js';
import {createRunner,cliAdapter} from '../server/runner.js';
import {manualActionRequest,decideManualAction} from '../server/manual-action.js';
import {normalizeCommand,isHighRiskCommand,matchingCommandApprovals} from '../server/command-permissions.js';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'tf-command-approval-')),s=createStore(join(root,'db.sqlite')),source=join(root,'source');mkdirSync(source);
 const u=s.addUser('Owner','owner','test-password'),pid=id();s.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(pid,'demo','Demo',source);s.db.prepare('INSERT INTO memberships VALUES (?,?)').run(u.id,pid);
 const task=createTask(s,u,{title:'Command approval test',description:'Probe Node child_process support',projectId:pid,type:'code'});
 Object.assign(task,{status:'queued',workspace:source,plan:{summary:'Original',acceptance:['done'],questions:[],steps:[{title:'Probe environment',role:'Engineer',instructions:'Run the probe script'}]},approvedVersion:1});
 s.saveTask(task);
 t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});
 return {s,u,task,root};
}

test('normalizeCommand only strips quotes around a single unquoted-looking token, never reorders or touches quoted args with spaces',()=>{
 assert.equal(normalizeCommand('node ".taskflow/probe-child-process.cjs"'),'node .taskflow/probe-child-process.cjs');
 assert.equal(normalizeCommand("node '.taskflow/probe-child-process.cjs'"),'node .taskflow/probe-child-process.cjs');
 assert.equal(normalizeCommand('  node   .taskflow/probe-child-process.cjs  '),'node .taskflow/probe-child-process.cjs');
 assert.equal(normalizeCommand('git commit -m "fix bug"'),'git commit -m "fix bug"','a quoted arg containing a space must not be unquoted');
});
test('isHighRiskCommand blocks destructive/irreversible operations but not an ordinary npm script',()=>{
 for(const cmd of ['git push origin main','npm publish','shutdown /s','rm -rf node_modules','Remove-Item -Recurse .\\dist','reg delete HKCU\\Foo','format C:'])assert.ok(isHighRiskCommand(cmd),cmd);
 for(const cmd of ['npm run format','node .taskflow/probe-child-process.cjs','npm install'])assert.ok(!isHighRiskCommand(cmd),cmd);
});

test('manualActionRequest marks a plain approval-required block as retryable but an elevation/administrator block as not',t=>{
 const f=fixture(t);
 f.task.status='waiting_input';
 f.task.userActionRequired={required:true,status:'pending',reason:'requires approval',actionType:'run_command',commands:['node ".taskflow/probe-child-process.cjs"'],workingDirectory:f.task.workspace,instructions:'x',verification:[],requiresAdministrator:false,category:'approval_required',threadId:'t1',phase:'execute',planVersion:1,at:new Date().toISOString()};
 assert.equal(manualActionRequest(f.s,f.task).retryable,true);
 f.task.userActionRequired={...f.task.userActionRequired,requiresAdministrator:true};
 assert.equal(manualActionRequest(f.s,f.task).retryable,false,'a genuine elevation requirement must never offer in-sandbox retry');
 f.task.userActionRequired={...f.task.userActionRequired,requiresAdministrator:false,commands:['git push origin main']};
 assert.equal(manualActionRequest(f.s,f.task).retryable,false,'a high-risk command must never be auto-retryable');
});

test('approve_once grants a one-time command approval bound to this task workspace and re-queues the same step',t=>{
 const f=fixture(t);
 f.task.status='waiting_input';
 f.task.userActionRequired={required:true,status:'pending',reason:'requires approval',actionType:'run_command',commands:['node ".taskflow/probe-child-process.cjs"'],workingDirectory:f.task.workspace,instructions:'x',verification:[],requiresAdministrator:false,category:'approval_required',threadId:'t1',phase:'execute',planVersion:1,at:new Date().toISOString()};
 f.s.saveTask(f.task);
 const request=manualActionRequest(f.s,f.task);
 assert.equal(request.retryable,true);
 const updated=decideManualAction(f.s,f.u,f.task.id,{requestId:request.id,decision:'approve_once'});
 assert.equal(updated.userActionRequired,null);
 assert.equal(updated.status,'queued');
 assert.equal(updated.commandApprovals.length,1);
 const approval=updated.commandApprovals[0];
 assert.equal(approval.command,'node ".taskflow/probe-child-process.cjs"');
 assert.equal(approval.normalizedCommand,'node .taskflow/probe-child-process.cjs');
 assert.equal(approval.cwd,f.task.workspace);
 assert.equal(approval.status,'approved');
 assert.equal(approval.scope,'once');
 assert.equal(approval.approvedBy,f.u.id);
});

test('approve_once is refused for a non-retryable request and for a workspace mismatch',t=>{
 const f=fixture(t);
 f.task.status='waiting_input';
 f.task.userActionRequired={required:true,status:'pending',reason:'needs admin',actionType:'run_command',commands:['npx prisma migrate dev'],workingDirectory:f.task.workspace,instructions:'x',verification:[],requiresAdministrator:true,category:'approval_required',threadId:'t1',phase:'execute',planVersion:1,at:new Date().toISOString()};
 f.s.saveTask(f.task);
 let request=manualActionRequest(f.s,f.task);
 assert.throws(()=>decideManualAction(f.s,f.u,f.task.id,{requestId:request.id,decision:'approve_once'}),{status:409});
 f.task.userActionRequired={...f.task.userActionRequired,requiresAdministrator:false,workingDirectory:join(f.task.workspace,'..','outside')};
 f.s.saveTask(f.task);
 request=manualActionRequest(f.s,f.task);
 assert.equal(request.retryable,true);
 assert.throws(()=>decideManualAction(f.s,f.u,f.task.id,{requestId:request.id,decision:'approve_once'}),{status:409},'a working directory outside the task workspace must never be approved');
});

test('the runner bakes an approved command into --allowedTools for the very next attempt only, then spends it',async t=>{
 const f=fixture(t);f.s.setSetting('runnerEnabled',true);
 const seenExtraTools=[];let calls=0;
 const runner=createRunner(f.s,{dataDir:join(f.root,'data'),adapter:async o=>{calls++;seenExtraTools.push(o.extraAllowedTools||null);
  if(calls===1)return {result:{summary:'Tool execution failed: This command requires approval: node ".taskflow/probe-child-process.cjs"',passed:false,questions:[],evidence:['This command requires approval: node ".taskflow/probe-child-process.cjs"'],artifacts:[],userActionRequired:{required:true,reason:null,actionType:'run_command',commands:['node ".taskflow/probe-child-process.cjs"'],workingDirectory:null,instructions:null,verification:[],requiresAdministrator:false}}};
  return {result:{summary:'probe passed',passed:true,questions:[],evidence:['node-child ok'],artifacts:[]}};
 }});
 try{
  await runner.tick();
  let task=f.s.task(f.task.id);
  assert.equal(task.userActionRequired.status,'pending');
  const request=manualActionRequest(f.s,task);
  assert.equal(request.retryable,true);
  decideManualAction(f.s,f.u,task.id,{requestId:request.id,decision:'approve_once'});
  task=f.s.task(f.task.id);
  assert.equal(task.status,'queued');
  assert.equal(matchingCommandApprovals(task,task.workspace).length,1);

  await runner.tick();
  assert.equal(calls,2);
  assert.ok(seenExtraTools[1].includes('Bash(node ".taskflow/probe-child-process.cjs")'));
  assert.ok(seenExtraTools[1].includes('Bash(node .taskflow/probe-child-process.cjs)'));

  task=f.s.task(f.task.id);
  assert.equal(task.commandApprovals[0].status,'consumed','the grant must be spent immediately once handed to a CLI attempt');
  assert.equal(matchingCommandApprovals(task,task.workspace).length,0,'a consumed approval must never be reused on a later attempt');
 }finally{runner.stop();}
});

test('cliAdapter includes extraAllowedTools in the Claude CLI --allowedTools argument',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'tf-cliadapter-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let capturedArgs=null;
 const spawnProcess=(exe,args)=>{capturedArgs=args;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{setImmediate(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({type:'result',session_id:'s',structured_output:{summary:'ok',questions:[],artifacts:[],passed:true,evidence:['e']}})+'\n'));child.emit('close',0);});};return child;};
 await cliAdapter({engine:'claude',prompt:'Do it',cwd:dir,runDir:dir,schema:resultJson,readOnly:false,onEvent:()=>{},spawnProcess,extraAllowedTools:['Bash(node .taskflow/probe-child-process.cjs)']});
 const idx=capturedArgs.indexOf('--allowedTools');
 assert.ok(idx>=0);
 assert.ok(capturedArgs.slice(idx+1).includes('Bash(node .taskflow/probe-child-process.cjs)'));
});
