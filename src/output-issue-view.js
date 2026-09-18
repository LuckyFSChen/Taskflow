// 成果報告不完整（Output Issue）的顯示邏輯（與 Vue 無關，方便測試）。
//
// 目的：使用者不需要知道 Zod、schema 或欄位代號。畫面上只出現
//   「發生了什麼」「TaskFlow 保留了什麼」「現在仍缺少什麼」「可以做什麼」。
// Zod 的原始訊息一律只放在「技術資訊」裡，不得成為主要 UI。
//
// outputIssueView(task) 回傳 null（這個任務沒有成果報告問題），或：
//   {title,lead,retained,noRerunNote,missingTitle,missing,actions,technical}

export const OUTPUT_ISSUE_TITLE='成果報告不完整';
export const OUTPUT_ISSUE_LEAD='AI 已完成工作，但回傳的成果格式缺少必要資訊。';
export const RETAINED_TITLE='TaskFlow 已保留：';
export const RETAINED_ITEMS=['原始 AI 回傳','已完成進度','工作副本','執行紀錄'];
export const NO_RERUN_NOTE='TaskFlow 不會因為報告格式問題重新執行已完成工作。';
export const MISSING_TITLE='目前仍缺少：';
export const REPLAN_NOTE='重新規劃是新計畫，不是單純格式修復。';
export const TECHNICAL_TITLE='技術資訊';

// 欄位代號 → 使用者看得懂的名稱。沒有對應的欄位照原樣列出，寧可讓人看到陌生的
// 欄位名，也不要悄悄少報一項缺少的東西。
export const FIELD_LABELS={
  summary:'工作摘要',
  evidence:'可確認的驗證證據',
  questions:'待確認問題清單',
  artifacts:'產出檔案清單',
  passed:'驗收結果',
  acceptance:'驗收條件',
  steps:'執行步驟',
  browserValidation:'Browser 驗證紀錄',
  userActionRequired:'需要你處理的操作',
};

function text(value){return typeof value==='string'?value.trim():'';}

export function fieldLabel(field){
  const key=text(field);
  return FIELD_LABELS[key]||key;
}

// Zod 訊息長成「questions：Required」或「根物件：…」；這裡只取欄位名，
// 訊息本身留給技術資訊。
function fieldFromIssue(issue){
  const line=text(issue);
  if(!line)return '';
  const field=line.split(/[：:]/)[0].trim().split('.')[0];
  return field==='根物件'?'':field;
}

/**
 * 這個問題目前「仍缺少」哪些東西。
 * 優先採用 deterministic recovery 得到的結論（它真的試過整理了），
 * 沒有才退回建立問題當下的 schema 欄位。
 * @param {any} issue
 * @returns {string[]} 欄位代號
 */
export function missingFields(issue){
  const fromRecovery=Array.isArray(issue?.recovery?.missing)?issue.recovery.missing.map(text).filter(Boolean):[];
  const source=fromRecovery.length?fromRecovery:(Array.isArray(issue?.issues)?issue.issues.map(fieldFromIssue).filter(Boolean):[]);
  return source.filter((field,index,all)=>all.indexOf(field)===index);
}

/**
 * @param {any} issue
 * @returns {string[]} 使用者看得懂的名稱
 */
export function missingFieldLabels(issue){
  return missingFields(issue).map(fieldLabel);
}

/**
 * 可以提供的操作。
 * - recover：只有在真的還能重新執行 deterministic recovery 時才出現，
 *   不給使用者一個注定失敗的按鈕。
 * - raw：永遠保留，原始回傳一直都在。
 * - replan：既有流程，但必須說清楚那是新計畫，不是單純格式修復。
 * @param {any} task
 */
export function outputIssueActions(task){
  const actions=[];
  if(task?.outputIssue?.recoverable)actions.push({id:'recover',label:'重新整理成果報告',note:'只重新整理已經收到的回傳，不會再次執行工作。'});
  actions.push({id:'raw',label:'查看原始回傳',note:'顯示 AI 這次實際回傳的內容。'});
  actions.push({id:'replan',label:'補充需求並重新規劃',note:REPLAN_NOTE});
  return actions;
}

/**
 * 畫面需要的全部內容；沒有成果報告問題時回傳 null。
 * @param {any} task
 */
export function outputIssueView(task){
  const issue=task?.outputIssue;
  if(!issue)return null;
  return {
    title:OUTPUT_ISSUE_TITLE,
    lead:OUTPUT_ISSUE_LEAD,
    retainedTitle:RETAINED_TITLE,
    retained:[...RETAINED_ITEMS],
    noRerunNote:NO_RERUN_NOTE,
    missingTitle:MISSING_TITLE,
    missing:missingFieldLabels(issue),
    actions:outputIssueActions(task),
    technical:{
      title:TECHNICAL_TITLE,
      issues:Array.isArray(issue.issues)?issue.issues.map(text).filter(Boolean):[],
      message:text(issue.message),
      reason:text(issue.recovery?.reason),
      notes:Array.isArray(issue.recovery?.notes)?issue.recovery.notes.map(text).filter(Boolean):[],
    },
  };
}
