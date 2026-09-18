// 首次設定精靈的顯示邏輯（與 Vue 無關，方便測試）。
//
// 這個檔案不做任何檢查、也不保存任何狀態：
//   - 系統檢查的資料來自 /api/system/health，經由既有的 src/system-health-view.js
//     分組後取用，這裡沒有第二套 health checker。
//   - AI 模式的選項與說明來自既有的 src/task-defaults.js，與建立任務表單、LINE
//     建立流程是同一組值。
//   - 要不要顯示精靈由後端的設定狀態決定（server/onboarding.js），前端不自己猜
//     「是不是第一次登入」。
//
// 精靈永遠不會擋住使用者：系統檢查有錯誤仍然可以繼續，也隨時可以「稍後設定」；
// 環境問題交給首頁既有的提醒（healthAlert）持續顯示。

import {healthGroups} from './system-health-view.js';
import {AI_MODES,AUTO,autoModeSummary} from './task-defaults.js';

export const ONBOARDING_STEPS=[
  {id:'system',label:'系統檢查',heading:'先確認執行環境',description:'只讀取狀態並詢問 CLI 版本，不會安裝、登入或修改任何設定。'},
  {id:'project',label:'專案位置',heading:'選擇專案要放在哪裡',description:'之後依任務標題建立的新專案，都會放在這個位置。'},
  {id:'ai',label:'AI 模式',heading:'決定誰來規劃、執行與驗證',description:'預設是自動選擇，不需要先理解模型分工。'},
  {id:'task',label:'建立第一個任務',heading:'建立第一個任務',description:'直接打開既有的建立任務表單，不是另一套流程。'}
];

// 第一步只顯示「開始工作前一定要確認」的項目；專案路徑與 LINE 不放在這裡
// （專案是第二步的事，LINE 是選用的），完整清單仍在平台設定的系統狀態。
export const WIZARD_HEALTH_KEYS=['runtime','codex','claude','browser'];

export function stepIndex(id){return ONBOARDING_STEPS.findIndex(step=>step.id===id);}
export function stepAt(index){return ONBOARDING_STEPS[index]||null;}
export function firstStepId(){return ONBOARDING_STEPS[0].id;}
export function nextStepId(id){const next=stepAt(stepIndex(id)+1);return next?next.id:null;}
export function previousStepId(id){const index=stepIndex(id);return index>0?ONBOARDING_STEPS[index-1].id:null;}
export function stepDefinition(id){return ONBOARDING_STEPS[stepIndex(id)]||null;}

/**
 * 要不要顯示精靈。以後端算出的設定狀態為準；成員（非管理者）永遠不顯示，
 * 因為精靈裡的每一件事都需要管理者權限。
 */
export function shouldShowOnboarding({user=null,onboarding=null}={}){
  if(user?.role!=='admin')return false;
  return onboarding?.show===true;
}

/** 第一步的項目：直接沿用系統狀態的分組結果，只挑出開始工作前需要看的幾項。 */
export function systemCheckItems(health){
  return healthGroups(health).flatMap(group=>group.items).filter(item=>WIZARD_HEALTH_KEYS.includes(item.key));
}

/**
 * 第一步的結論。刻意不回傳「可以開始了」這種保證，只說目前有哪些項目不能用；
 * blocking 永遠是 false：環境有問題不會讓使用者卡在精靈裡。
 */
export function systemCheckSummary(health){
  const items=systemCheckItems(health);
  const errors=items.filter(item=>item.status==='error');
  const unresolved=items.filter(item=>item.status==='warning'||item.status==='unknown');
  return {
    checked:!!health?.checkedAt,
    items,
    blocking:false,
    errors:errors.map(item=>`${item.label}：${item.message}`),
    warnings:unresolved.map(item=>`${item.label}：${item.message}`),
    note:errors.length
      ?'有項目目前無法使用。你仍然可以繼續設定，首頁會持續提醒直到問題解決。'
      :unresolved.length
        ?'有項目尚未就緒，之後仍可在平台設定重新檢查。'
        :'目前這幾項都可以使用。'
  };
}

/** 每一步「做完了沒有」，全部由既有狀態推導，不另外記錄進度。 */
export function stepDone(id,context={}){
  if(id==='system')return !!context.health?.checkedAt;
  if(id==='project')return !!context.defaultProjectRoot;
  if(id==='ai')return !!context.aiMode;
  if(id==='task')return !!context.hasTask;
  return false;
}

/**
 * 不能進入下一步的原因；null 代表可以繼續。
 * 只有「專案位置」會擋：沒有存放位置就無法用任務標題建立第一個專案。
 * 系統檢查即使是 error 也不擋（見檔案開頭）。
 */
export function stepBlocker(id,context={}){
  if(id==='project'&&!context.defaultProjectRoot)return '請先選擇一個資料夾，作為預設專案存放位置。';
  if(id==='task'&&!context.defaultProjectRoot)return '請先回到「專案位置」選擇存放位置。';
  return null;
}

export function canAdvance(id,context={}){return !stepBlocker(id,context);}

/** 給畫面用的步驟列：目前在哪一步、哪些已完成。 */
export function wizardSteps(currentId,context={}){
  return ONBOARDING_STEPS.map((step,index)=>{
    const current=step.id===currentId,done=stepDone(step.id,context);
    return {id:step.id,label:step.label,index:index+1,current,done,state:current?'current':done?'done':'todo'};
  });
}

export function aiModeOptions(){return AI_MODES;}
export function defaultAiMode(){return AUTO;}

/** 第三步的說明：與建立任務表單同一組安排，不在這裡重新發明一套文案來源。 */
export function aiModeDescription(type){
  return `TaskFlow 會依任務類型自動安排規劃、執行與驗證模型：${autoModeSummary(type)}`;
}
