import {defineStore} from 'pinia';
import {api} from './api';
export {api} from './api';
export const useTaskStore=defineStore('tasks',{state:()=>({user:null as any,defaultProjectRoot:'',tasks:[] as any[],projects:[] as any[],runner:{enabled:false,busy:false,maxConcurrent:1,activeCount:0,activeTaskId:null as string|null},integrations:{lineConfigured:false,lastSync:null,error:null,pendingNotifications:0} as any,loaded:false,offline:false}),actions:{async refresh(){try{const data=await api('/state');Object.assign(this,data);this.offline=false;this.loaded=true;}catch(e){this.offline=true;throw e;}}}});
