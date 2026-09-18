// 建立任務表單的預設安排（與 Vue 無關，方便測試）。
//
// 目的：第一次使用 TaskFlow 的人不必先理解 Planner／Executor／Reviewer 是什麼，
// 也能建立出安排正確的任務。
//
// 這裡「不發明」新的 Domain 行為：下面的對應就是系統目前既有的安排，
// 與 LINE 建立任務流程（server/line-ui.js 的 submit）用的是同一組值。
// tests/task-defaults.test.js 會實際跑一次 LINE 建立流程，把兩邊釘在一起，
// 任何一邊改了而另一邊沒改都會讓測試失敗。

export const AUTO='auto',CUSTOM='custom';

export const TASK_TYPES=[
  {value:'code',label:'程式開發'},
  {value:'research',label:'研究與文件'},
];

export const AI_MODES=[
  {value:AUTO,label:'自動選擇（推薦）'},
  {value:CUSTOM,label:'自訂'},
];

export const ENGINE_LABELS={claude:'Claude Code',codex:'Codex'};

export const ROLE_LABELS={planner:'規劃',executor:'執行',reviewer:'驗證'};

// 任務類型 → 三個角色的引擎。未知的類型一律當成程式開發處理，
// 不猜測、也不回傳空值讓呼叫端自己想辦法。
export function taskEngineDefaults(type){
  return type==='research'
    ? {planner:'claude',executor:'claude',reviewer:'codex'}
    : {planner:'claude',executor:'codex',reviewer:'claude'};
}

export function engineLabel(engine){return ENGINE_LABELS[engine]||engine;}

/**
 * 自動模式時顯示給使用者看的一句話：說明會怎麼安排，而不是把三個選單塞給他。
 * @param {string} type
 */
export function autoModeSummary(type){
  const engines=taskEngineDefaults(type);
  return Object.entries(ROLE_LABELS).map(([role,label])=>`${label} ${engineLabel(engines[role])}`).join(' · ');
}

/**
 * 依目前模式與任務類型，決定送出時真正要用的三個引擎。
 * 自動模式一律採用該類型的預設；自訂模式沿用使用者自己挑的，
 * 缺漏的欄位才退回預設，不會送出空值。
 * @param {{aiMode?:string,type?:string,planner?:string,executor?:string,reviewer?:string}} form
 */
export function resolveEngines(form){
  const defaults=taskEngineDefaults(form?.type);
  if(form?.aiMode===CUSTOM){
    return {
      planner:form.planner||defaults.planner,
      executor:form.executor||defaults.executor,
      reviewer:form.reviewer||defaults.reviewer,
    };
  }
  return defaults;
}
