// 首次設定的「設定狀態」。
//
// 這裡只回答一個問題：這個工作空間還需不需要被帶著走一次設定流程。
//
// 判斷刻意不去猜「是不是第一次登入」（那既不可靠也沒有對應的既有狀態），而是
// 讀 TaskFlow 本來就有的狀態，再加上一個明確的旗標：
//   - defaultProjectRoot：設定過預設專案存放位置
//   - projects：已經有任何專案
//   - onboardingCompleted：使用者完成精靈，或明確選擇「稍後設定」
//
// 沒有新資料表、沒有新欄位、也不記錄步驟進度：精靈的每一步都把結果寫回它原本
// 就該寫的地方（defaultProjectRoot、專案、任務），所以這裡不會出現第二份狀態。
// 這個檔案也完全不執行任何檢查或修復，只讀狀態。

export const ONBOARDING_SETTING='onboardingCompleted';

// 既有安裝的判斷依據：兩者都有，代表這個工作空間本來就設定完成了。
export function workspaceSignals(store){
  return {
    hasProjectRoot:!!store.setting('defaultProjectRoot',''),
    hasProject:!!store.db.prepare('SELECT 1 FROM projects LIMIT 1').get()
  };
}

/**
 * 目前的設定狀態。純讀取：呼叫這個函式永遠不會寫入任何設定。
 * @param {object} store
 * @param {{role?:string}|null} user
 */
export function onboardingStatus(store,user){
  const {hasProjectRoot,hasProject}=workspaceSignals(store);
  // 推導，不是寫入：已經有存放位置也有專案的舊安裝，不會因為這個版本上線就
  // 突然被要求跑一次精靈。
  const configured=hasProjectRoot&&hasProject;
  const dismissed=store.setting(ONBOARDING_SETTING,false)===true;
  const completed=dismissed||configured;
  // 精靈裡的每一件事（設定存放位置、建立專案）都只有管理者能做，所以成員永遠
  // 不會被一個他無法完成的流程擋住；成員看到的仍是既有的「請管理者為你分配專案」。
  const canConfigure=user?.role==='admin';
  return {completed,dismissed,configured,hasProjectRoot,hasProject,canConfigure,show:canConfigure&&!completed};
}

/**
 * 記錄「已完成」或「稍後設定」。兩者寫的是同一個旗標：它記錄的是使用者已經看過
 * 並自己做了決定，不是宣稱環境沒問題——系統狀態有錯誤時，首頁仍會繼續提醒。
 * 呼叫端（app.js）已用 admin middleware 擋住非管理者。
 */
export function completeOnboarding(store,user){
  store.setSetting(ONBOARDING_SETTING,true);
  return onboardingStatus(store,user);
}

// 想再看一次精靈不需要任何 API：平台設定裡的按鈕直接在前端開啟同一個元件，
// 所以「重新打開」這件事不會把已經記錄下來的決定改掉。

