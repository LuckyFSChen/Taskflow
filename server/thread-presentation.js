import {toolAccessFailure} from './validation-skip.js';

export function threadPresentation(thread){
  // Git 守門在這個階段開始執行前就擋下來了：它既不是失敗也不是取消，而是「等你確認」。
  // 標成失敗會讓使用者以為程式壞了，也和「Git dirty 不是 execution failed」的原則相衝突。
  if(thread.stoppedReason==='git_blocked')return {displayStatus:'waiting_git_confirmation',statusLabel:'等待你確認 Git 狀態'};
  if(thread.status!=='completed')return {};
  if(thread.result?.manualActionSkipped)return {displayStatus:'paused',statusLabel:'已略過（未驗證）'};
  if(thread.result?.userActionRequired?.required)return {displayStatus:'waiting_user_action',statusLabel:'需要你的協助'};
  if(thread.result?.questions?.length)return {displayStatus:'waiting_input',statusLabel:'等待回答'};
  if(['plan','repair_plan'].includes(thread.phase))return {displayStatus:'awaiting_approval',statusLabel:'規劃已產出'};
  if(thread.result?.passed===false)return toolAccessFailure(thread.result)
    ?{displayStatus:'waiting_input',statusLabel:'驗證受限／未通過'}
    :{displayStatus:'failed',statusLabel:'未通過驗收'};
  if(thread.result?.passed===true)return {displayStatus:'completed',statusLabel:thread.phase==='review'?'驗證通過':'步驟檢查通過'};
  return {displayStatus:'paused',statusLabel:'已結束／未驗證'};
}
