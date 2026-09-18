import {toolAccessFailure} from './validation-skip.js';

export function threadPresentation(thread){
  if(thread.status!=='completed')return {};
  if(thread.result?.manualActionSkipped)return {displayStatus:'paused',statusLabel:'已略過（未驗證）'};
  if(thread.result?.userActionRequired?.required)return {displayStatus:'waiting_input',statusLabel:'需要你的協助'};
  if(thread.result?.questions?.length)return {displayStatus:'waiting_input',statusLabel:'等待回答'};
  if(['plan','repair_plan'].includes(thread.phase))return {displayStatus:'awaiting_approval',statusLabel:'規劃已產出'};
  if(thread.result?.passed===false)return toolAccessFailure(thread.result)
    ?{displayStatus:'waiting_input',statusLabel:'驗證受限／未通過'}
    :{displayStatus:'failed',statusLabel:'未通過驗收'};
  if(thread.result?.passed===true)return {displayStatus:'completed',statusLabel:thread.phase==='review'?'驗證通過':'步驟檢查通過'};
  return {displayStatus:'paused',statusLabel:'已結束／未驗證'};
}
