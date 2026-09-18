import {defineStore} from 'pinia';
import {api} from './api';
export {api} from './api';
export const useTaskStore=defineStore('tasks',{state:()=>({user:null as any,defaultProjectRoot:'',tasks:[] as any[],projects:[] as any[],runner:{enabled:false,busy:false,maxConcurrent:1,activeCount:0,activeTaskId:null as string|null},integrations:{lineConfigured:false,lastSync:null,error:null,pendingNotifications:0} as any,health:{status:'unknown',checkedAt:null,checks:{}} as any,healthLoading:false,healthError:'',loaded:false,offline:false}),actions:{
  async refresh(){try{const data=await api('/state');Object.assign(this,data);this.offline=false;this.loaded=true;}catch(e){this.offline=true;throw e;}},
  // 系統狀態會實際執行 CLI 檢查，所以刻意不放進每 3 秒的輪詢：只在頁面載入、
  // 進入平台設定與使用者按下「重新檢查」時讀取（後端另有節流，避免連續 spawn）。
  async loadHealth(force=false){if(this.healthLoading)return;this.healthLoading=true;try{this.health=await api('/system/health'+(force?'?refresh=1':''));this.healthError='';}catch(e:any){this.healthError=e?.message||'目前無法取得系統狀態。';}finally{this.healthLoading=false;}}
}});
