// 系統狀態的顯示邏輯（與 Vue 無關，方便測試）。
//
// 後端 /api/system/health 只回報事實，這裡只負責分組、挑字與決定首頁要不要
// 提醒；不判斷系統好壞，也不會嘗試修復、安裝或修改任何設定。
//
// healthGroups(health) 回傳畫面用的分組：
//   [{label,items:[{key,label,status,mark,message}]}]
// healthAlert(health)  回傳 null（不需提醒）或 {title,messages,action}

const MARKS={ok:'✓',warning:'⚠',error:'✗',unknown:'？'};
const STATUS_LABELS={ok:'正常',warning:'需要注意',error:'有問題',unknown:'尚未確認'};
const CHECK_LABELS={runtime:'Node',runner:'任務服務',codex:'Codex',claude:'Claude',git:'Git',browser:'Playwright MCP',projects:'專案路徑',line:'LINE'};
// 顯示順序固定，使用者每次看到的版面一致；後端新增的檢查若沒有分組會被忽略，
// 不會因為多了一項就把版面弄亂。
const GROUPS=[
  {label:'Runtime',keys:['runtime','git']},
  {label:'AI Engines',keys:['codex','claude']},
  {label:'Browser',keys:['browser']},
  {label:'Runner',keys:['runner']},
  {label:'Projects',keys:['projects']},
  {label:'LINE',keys:['line']}
];

// 不認得的狀態一律當成「尚未確認」，絕不樂觀地當成正常。
function normalize(status){return Object.hasOwn(MARKS,status)?status:'unknown';}
function message(check,key){
  const text=typeof check?.message==='string'?check.message.trim():'';
  return text||`${CHECK_LABELS[key]||key} 尚未取得檢查結果`;
}

export function healthMark(status){return MARKS[normalize(status)];}
export function healthStatusLabel(status){return STATUS_LABELS[normalize(status)];}
export function healthCheckLabel(key){return CHECK_LABELS[key]||key;}

export function healthGroups(health){
  const checks=health&&typeof health.checks==='object'&&health.checks?health.checks:{};
  return GROUPS.map(group=>({
    label:group.label,
    items:group.keys.filter(key=>checks[key]).map(key=>({
      key,
      label:healthCheckLabel(key),
      status:normalize(checks[key].status),
      mark:healthMark(checks[key].status),
      message:message(checks[key],key)
    }))
  })).filter(group=>group.items.length);
}

// 首頁提醒只在 error 時出現，而且只列出真的壞掉的項目：其他引擎可能仍然正常
// （例如 Codex 可用、Claude 壞掉），所以這只是提醒，不會停用 TaskFlow 的任何功能。
export function healthAlert(health){
  if(normalize(health?.status)!=='error')return null;
  const failed=Object.entries(health?.checks||{}).filter(([,check])=>check?.status==='error');
  if(!failed.length)return null;
  return {title:'執行環境有問題',messages:failed.map(([key,check])=>message(check,key)),action:'查看系統狀態'};
}
