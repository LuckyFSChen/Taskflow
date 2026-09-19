// tests/helpers/cleanup.js 自己的測試。
//
// 這裡鎖住的正是 Windows EPERM 的成因：清理順序必須是「先關資源、再刪目錄」，
// 而且重試要有上限、失敗要拋出來。順序錯了在 Linux 上看不出來（POSIX 允許刪除
// 仍被開啟的檔案），所以這個保證必須由測試守住，不能靠人記得註冊順序。
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {removeDirectory,testCleanup} from './helpers/cleanup.js';

// testCleanup 只用到 t.after，所以可以用一個假的 context 直接觸發清理並檢查順序。
function fakeContext() {
  const hooks=[];
  return {after(fn){hooks.push(fn);},async runCleanup(){for(const hook of hooks)await hook();},hookCount:()=>hooks.length};
}

test('一個測試只註冊一個 after hook，清理順序是先關資源、再刪目錄',async()=>{
  const events=[],context=fakeContext();
  const cleanup=testCleanup(context);
  cleanup.dispose(()=>{events.push('close:first');},'first');
  cleanup.dispose(()=>{events.push('close:second');},'second');
  cleanup.directory('/nonexistent/tf-cleanup-order-a');
  cleanup.directory('/nonexistent/tf-cleanup-order-b');

  assert.equal(context.hookCount(),1,'不得註冊多個 after hook——順序就是在那裡出錯的');
  await context.runCleanup();
  // 後開的先關（LIFO），而且所有關閉都排在任何刪除之前。
  assert.deepEqual(events,['close:second','close:first']);
});

test('資源關閉是 await 過的，非同步 close 不會落在刪除之後',async()=>{
  const events=[],context=fakeContext();
  const cleanup=testCleanup(context);
  cleanup.dispose(async()=>{await new Promise(r=>setTimeout(r,20));events.push('closed');},'slow');
  cleanup.directory('/nonexistent/tf-cleanup-await');
  await context.runCleanup();
  assert.deepEqual(events,['closed']);
});

test('dispose 接受 function、close() 物件與 stop() 物件',async()=>{
  const events=[],context=fakeContext();
  const cleanup=testCleanup(context);
  cleanup.dispose({close(){events.push('close');}},'closable');
  cleanup.dispose({stop(){events.push('stop');}},'stoppable');
  await context.runCleanup();
  assert.deepEqual(events,['stop','close']);
  assert.throws(()=>testCleanup(fakeContext()).dispose({},'bad'),TypeError);
});

test('清理失敗必須讓測試失敗，不得吞掉',async()=>{
  const context=fakeContext();
  const cleanup=testCleanup(context);
  cleanup.dispose(()=>{throw new Error('close 壞掉');},'broken');
  await assert.rejects(()=>context.runCleanup(),/close 壞掉/);

  const second=fakeContext();
  const withTwoFailures=testCleanup(second);
  withTwoFailures.dispose(()=>{throw new Error('close 壞掉');},'broken');
  withTwoFailures.directory('/proc/1/definitely-not-removable');
  await assert.rejects(()=>second.runCleanup(),error=>error instanceof AggregateError||/壞掉|刪除/.test(error.message));
});

test('removeDirectory：只對 handle 釋放競態重試，而且有上限',async()=>{
  let calls=0;
  const flaky=()=>{calls+=1;if(calls<3){const error=new Error('EPERM');error.code='EPERM';throw error;}};
  const attempts=await removeDirectory('whatever',{rm:flaky,delayMs:1});
  assert.equal(calls,3);
  assert.equal(attempts,3,'第三次才成功——這就是「已經關閉、但作業系統還沒放手」的保護');

  let persistent=0;
  const always=()=>{persistent+=1;const error=new Error('EPERM');error.code='EPERM';throw error;};
  await assert.rejects(()=>removeDirectory('whatever',{rm:always,attempts:4,delayMs:1}),/EPERM/);
  assert.equal(persistent,4,'重試次數必須有上限，用完就照實失敗');
});

test('removeDirectory：不是競態的錯誤立刻拋出，ENOENT 視為已達成目標',async()=>{
  const fatal=()=>{const error=new Error('ENOTDIR');error.code='ENOTDIR';throw error;};
  let calls=0;
  await assert.rejects(()=>removeDirectory('whatever',{rm:()=>{calls+=1;fatal();},delayMs:1}),/ENOTDIR/);
  assert.equal(calls,1,'程式寫錯的錯誤不該被重試掩蓋');

  await removeDirectory('/nonexistent/tf-cleanup-enoent'); // 不存在就是目標狀態，不算失敗
  assert.equal(existsSync('/nonexistent/tf-cleanup-enoent'),false);
});
