import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../server/db.js';
import {createApp,allowedOrigins} from '../server/app.js';

test('Public tunnel origin preserves local access without trusting other tunnel hosts',()=>{
  const previous=process.env.PUBLIC_ORIGIN;
  try {
    process.env.PUBLIC_ORIGIN='https://taskflow-test.trycloudflare.com';
    const origins=allowedOrigins();
    assert.ok(origins.includes(process.env.PUBLIC_ORIGIN));
    assert.ok(origins.includes('http://127.0.0.1:4310'));
    assert.ok(origins.includes('http://localhost:4310'));
    assert.ok(!origins.includes('https://another.trycloudflare.com'));
  } finally { if(previous===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=previous; }
});

test('First login works with localhost and 127.0.0.1; unrelated origins remain blocked',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'taskflow-origin-'));
  const store=createStore(join(directory,'db.sqlite'));
  store.addUser('Admin','admin','test-only-password-123','admin');
  const app=createApp(store,{status:{busy:false,activeTaskId:null}},{dist:join(directory,'no-dist')});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const origin of ['http://localhost:4310','http://127.0.0.1:4310','http://[::1]:4310']) {
    const response=await fetch(base+'/api/login',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-password-123'})});
    assert.equal(response.status,200,origin);
    const cookie=response.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base+'/api/state',{headers:{cookie}})).status,200);
    assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{origin,cookie,'Content-Type':'application/json'},body:'{}'})).status,200);
  }
  for(const origin of ['https://evil.example','http://localhost.evil.example:4310','http://localhost:4311','null']) {
    const response=await fetch(base+'/api/login',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-only-password-123'})});
    assert.equal(response.status,403,origin);
  }
});
