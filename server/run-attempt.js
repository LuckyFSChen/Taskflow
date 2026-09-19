// Run／Attempt：把同一個邏輯步驟因重試／額度受限／服務中斷恢復而產生的多筆 thread
// （Attempt）收攏成一個 Run。純函式、唯讀、不落地——不新增資料表、不改 threads 既有欄位。
// 完整對應表、分組鍵推導依據與相容性風險見 docs/DOMAIN-MODEL-RUN-ATTEMPT.md。
//
// 刻意不做的事：
//   - 不新增 threads／tasks 資料表欄位，也不在 threads.data 塞新的可選欄位。
//   - 不重新定義狀態機：Run.status／displayStatus／statusLabel 直接沿用「這個 Run 裡
//     最後一筆 Attempt」的既有 thread-presentation.js 判斷結果，不另外發明新狀態。
//   - 不刪減或改寫傳入的 thread 欄位；Attempt 就是原封不動的 thread 物件。
export function attemptPassed(th) {
  return th.phase==='execute'&&th.status==='completed'&&th.result?.passed===true&&!(th.result?.questions?.length);
}

// threads：已依 planVersion 篩選、依建立順序（store.threads() 的 rowid 順序）排列的 thread 陣列，
// 可以是已套用 threadPresentation() 的版本（帶 displayStatus/statusLabel），也可以是原始 thread；
// 沒有 displayStatus 時 Run 的狀態欄位就沿用 thread.status，不會拋錯。
// 回傳：Run[]，每個 Run 帶 attempts:Attempt[]（= 原始 thread，不刪減欄位）。空輸入回傳 []。
export function buildRuns(threads) {
  if(!Array.isArray(threads)||!threads.length)return [];
  const runs=[];
  const byKey=new Map();
  let stepCursor=0;
  for(const th of threads) {
    // execute 階段用「目前已通過驗收的 step 數」當游標，和 runner.js 的 runTask() 判斷
    // 「下一步要跑哪個 step」的邏輯完全一致（只是反過來從既有紀錄推回這筆屬於哪個 Run）；
    // 其餘 phase（plan/repair_plan/review/repair）同一輪本來就只有一個邏輯步驟。
    const stepIndex=th.phase==='execute'?stepCursor:null;
    const key=`${th.version}:${th.round}:${th.phase}:${stepIndex??''}`;
    let run=byKey.get(key);
    if(!run) {
      run={id:`${th.taskId}:${key}`,phase:th.phase,round:th.round,stepIndex,title:th.title,attempts:[]};
      byKey.set(key,run);
      runs.push(run);
    }
    run.attempts.push(th);
    run.title=th.title;
    if(th.phase==='execute'&&attemptPassed(th))stepCursor+=1;
  }
  for(const run of runs) {
    const last=run.attempts[run.attempts.length-1];
    run.status=last.status;
    run.displayStatus=last.displayStatus||last.status;
    run.statusLabel=last.statusLabel||null;
  }
  return runs;
}
