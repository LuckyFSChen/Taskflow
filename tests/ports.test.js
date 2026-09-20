// Port Ownership 的回歸測試。
//
// 這一組測試對應的事故：主服務讀泛用的 process.env.PORT，而那個變數同時是 Task／Preview
// runtime 用來宣告「我自己的 port」的變數。只要主服務是從某個 runtime 環境啟動的，它就會
// 綁到隨機高位 port（實際發生過：server.log 寫 60215，4310 沒有人監聽）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {
  allocateRuntimePort,
  infrastructureEnvironment,
  inheritedRuntimePorts,
  isReservedPort,
  mainServerOrigin,
  resolveGuardianPort,
  resolveMainPort,
  withoutInfrastructurePorts,
  RESERVED_PORTS,
  TASKFLOW_GUARDIAN_PORT,
  TASKFLOW_MAIN_PORT,
} from '../server/ports.js';
import {childEnvironment} from '../server/npm-runner.js';
import {allocatePort, serviceEnvironment} from '../server/runtime-manager.js';
import {normalizeService} from '../server/runtime-topology.js';
import {runServiceRecovery} from '../server/service-recovery.js';
import {allowedOrigins} from '../server/app.js';

test('TaskFlow Main Server 的預設 port 是 4310，Service Guardian 是 4311',()=>{
  assert.equal(TASKFLOW_MAIN_PORT,4310);
  assert.equal(TASKFLOW_GUARDIAN_PORT,4311);
  assert.equal(resolveMainPort({}),4310);
  assert.equal(resolveGuardianPort({}),4311);
  assert.equal(mainServerOrigin({}),'http://127.0.0.1:4310');
});

test('泛用的 PORT 屬於 runtime，不得改變主服務與 Guardian 的 port',()=>{
  // 這就是事故現場：某個 Task runtime 的 port 被繼承進主服務的啟動環境。
  const polluted={PORT:'52055',PREVIEW_PORT:'60215',BACKEND_PORT:'60216'};
  assert.equal(resolveMainPort(polluted),4310);
  assert.equal(resolveGuardianPort(polluted),4311);
  // 但它必須被看見：服務啟動時會照實記錄一行。
  assert.deepEqual(inheritedRuntimePorts(polluted),['PORT=52055','PREVIEW_PORT=60215','BACKEND_PORT=60216']);
});

test('要改主服務的 port 只能用 TASKFLOW_PORT，而且值必須說得通',()=>{
  assert.equal(resolveMainPort({TASKFLOW_PORT:'4500'}),4500);
  assert.equal(resolveGuardianPort({TASKFLOW_GUARDIAN_PORT:'4501'}),4501);
  // 看不懂的值一律丟錯：靜默退回預設值會讓「服務在哪個 port」再次變成猜的。
  assert.throws(()=>resolveMainPort({TASKFLOW_PORT:'abc'}),/TASKFLOW_PORT/);
  assert.throws(()=>resolveMainPort({TASKFLOW_PORT:'70000'}),/TASKFLOW_PORT/);
  assert.throws(()=>resolveMainPort({TASKFLOW_PORT:'0'}),/TASKFLOW_PORT/);
  // 主服務與 Guardian 不能是同一個 port。
  assert.throws(()=>resolveMainPort({TASKFLOW_PORT:'4311'}),/Guardian/);
  assert.throws(()=>resolveGuardianPort({TASKFLOW_GUARDIAN_PORT:'4310'}),/主服務/);
});

test('Runtime port 配發者永遠不會吐出 4310 或 4311',async()=>{
  assert.ok(isReservedPort(4310)&&isReservedPort(4311));
  assert.equal(isReservedPort(52055),false);
  assert.deepEqual([...RESERVED_PORTS].sort(),[4310,4311]);

  const queue=[4310,4311,52001];
  const port=await allocateRuntimePort({probe:async()=>queue.shift()});
  assert.equal(port,52001,'配到保留 port 必須重配，不能交出去');

  await assert.rejects(allocateRuntimePort({probe:async()=>4310,attempts:3}),/保留/);

  // 實際配一個：作業系統挑出來的 port 也必須通過同一道檢查。
  const real=await allocatePort();
  assert.ok(Number.isInteger(real)&&real>0&&!isReservedPort(real));
});

test('子程序不繼承主服務的 port 身分，但仍然拿得到自己的 port',()=>{
  const parent={PORT:'4310',HOST:'127.0.0.1',TASKFLOW_PORT:'4310',TASKFLOW_GUARDIAN_PORT:'4311',PATH:'/usr/bin'};
  const child=childEnvironment(parent);
  // 任務專案的 backend 曾因為繼承到 PORT=4310 而去綁主服務的 port。
  assert.equal(child.PORT,undefined);
  assert.equal(child.TASKFLOW_PORT,undefined);
  assert.equal(child.TASKFLOW_GUARDIAN_PORT,undefined);
  assert.equal(child.PATH,'/usr/bin');

  const env=serviceEnvironment({id:'api',type:'backend',environment:{}},{port:52010,peers:[],base:parent});
  assert.equal(env.PORT,'52010','每個 service 的 PORT 是它自己的 port');
  // 自我專案（TaskFlow 的 worktree）讀的是 TASKFLOW_PORT：不明確覆寫就會沿用 4310，
  // 於是一個任務的 runtime 直接撞上正式服務。
  assert.equal(env.TASKFLOW_PORT,'52010');
  assert.equal(env.TASKFLOW_HOST,'127.0.0.1');

  assert.equal(withoutInfrastructurePorts(parent).HOST,undefined);
});

test('由 TaskFlow 重新啟動的主服務一定帶著主服務的身分',()=>{
  const env=infrastructureEnvironment({PORT:'60215',PREVIEW_PORT:'60215',PATH:'/usr/bin'});
  assert.equal(env.PORT,undefined);
  assert.equal(env.TASKFLOW_PORT,'4310');
  assert.equal(env.TASKFLOW_GUARDIAN_PORT,'4311');
  assert.equal(env.PATH,'/usr/bin');
});

test('Service recovery 啟動的 server/index.js 不繼承 runtime port',async()=>{
  const previous=process.env.PORT;
  process.env.PORT='60215';
  let captured=null;
  try {
    await runServiceRecovery({spawnProcess:(command,args,options)=>{
      captured=options.env;
      return spawn(process.execPath,['--input-type=module','-e','import {writeFileSync} from "node:fs";writeFileSync(process.argv[1],JSON.stringify({ok:true,url:"https://ready.example.com"}));',args.at(-1)],{stdio:'ignore'});
    }});
  } finally { if(previous===undefined)delete process.env.PORT;else process.env.PORT=previous; }
  assert.ok(captured,'recovery 必須明確指定子程序環境，不能整碗繼承');
  assert.equal(captured.PORT,undefined);
  assert.equal(captured.TASKFLOW_PORT,'4310');
});

test('專案不得在 runtime 設定裡宣告 TaskFlow 的保留 port',()=>{
  const projectRoot=process.cwd();
  for(const port of [4310,4311]) {
    assert.throws(()=>normalizeService({id:'api',type:'backend',startCommand:'npm run dev',port},projectRoot),/保留/);
  }
  assert.equal(normalizeService({id:'api',type:'backend',startCommand:'npm run dev',port:52010},projectRoot).port,52010);
  assert.equal(normalizeService({id:'api',type:'backend',startCommand:'npm run dev'},projectRoot).port,null);
});

test('CORS 白名單跟著主服務的 port 走，不跟著繼承來的 PORT 走',()=>{
  const previousPort=process.env.PORT,previousOrigin=process.env.PUBLIC_ORIGIN;
  process.env.PORT='52055';
  delete process.env.PUBLIC_ORIGIN;
  try {
    const origins=allowedOrigins();
    assert.ok(origins.includes('http://127.0.0.1:4310'));
    assert.ok(origins.includes('http://localhost:4310'));
    assert.ok(!origins.some(origin=>origin.includes('52055')));
  } finally {
    if(previousPort===undefined)delete process.env.PORT;else process.env.PORT=previousPort;
    if(previousOrigin!==undefined)process.env.PUBLIC_ORIGIN=previousOrigin;
  }
});
