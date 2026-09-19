import {defineStore} from 'pinia';
import {api} from './api';
export {api} from './api';
export const useTaskStore=defineStore('tasks',{state:()=>({user:null as any,defaultProjectRoot:'',tasks:[] as any[],projects:[] as any[],
  // 方案群組（Plan Group）：任務佇列的分組依據，由 /api/state 帶回來。
  // 只有 id／名稱／專案這些穩定座標；完成度與狀態都在 src/plan-group.js 依真實 task state 算。
  planGroups:[] as any[],runner:{enabled:false,busy:false,maxConcurrent:1,activeCount:0,activeTaskId:null as string|null},integrations:{lineConfigured:false,lastSync:null,error:null,pendingNotifications:0} as any,health:{status:'unknown',checkedAt:null,checks:{}} as any,healthLoading:false,healthError:'',
  // 首次設定狀態由後端 /api/state 帶回（server/onboarding.js），前端不自己猜是不是第一次登入。
  onboarding:{completed:false,dismissed:false,configured:false,hasProjectRoot:false,hasProject:false,canConfigure:false,show:false} as any,
  loaded:false,offline:false}),actions:{
  async refresh(){try{const data=await api('/state');Object.assign(this,data);this.offline=false;this.loaded=true;}catch(e){this.offline=true;throw e;}},
  // 系統狀態會實際執行 CLI 檢查，所以刻意不放進每 3 秒的輪詢：只在頁面載入、
  // 進入平台設定與使用者按下「重新檢查」時讀取（後端另有節流，避免連續 spawn）。
  async loadHealth(force=false){if(this.healthLoading)return;this.healthLoading=true;try{this.health=await api('/system/health'+(force?'?refresh=1':''));this.healthError='';}catch(e:any){this.healthError=e?.message||'目前無法取得系統狀態。';}finally{this.healthLoading=false;}},
  // 完成精靈或選擇「稍後設定」都走這裡；只記錄「使用者已經自己做了決定」，
  // 不代表環境沒問題：系統狀態仍由 /api/system/health 決定。
  async completeOnboarding(){this.onboarding=await api('/onboarding/complete',{});}
}});
