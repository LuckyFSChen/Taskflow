<script setup lang="ts">
import {ref,onMounted} from 'vue';
import {Folder,ExternalLink,Square,LoaderCircle} from 'lucide-vue-next';
import {api,useTaskStore} from './store';
const store=useTaskStore();
const props=defineProps<{project:any}>();
const targets=ref<any[]>([]),chosen=ref(''),busy=ref(false),message=ref(''),url=ref(''),runtime=ref<any>(null);
async function refresh(){
  const data=await api(`/projects/${props.project.id}/targets`);
  targets.value=data.targets;
  const preview=targets.value.find(t=>(t.taskId||'')===chosen.value)?.preview;
  url.value=preview?.url||'';
  // Multi-Service 專案的 Preview 不是一個程序，而是一組。使用者要看得到每個服務
  // 各自跑在哪個連接埠、是不是 READY，失敗時卡在哪一層（計畫書第二十八章）。
  runtime.value=preview?.runtime||null;
}
onMounted(async()=>{try{await refresh();const latest=targets.value.find(t=>t.taskId&&t.web);if(latest){chosen.value=latest.taskId;await refresh();}}catch(e:any){message.value=e.message;}});
async function stopAll(){busy.value=true;try{await api(`/admin/projects/${props.project.id}/previews/stop`,{});await refresh();message.value='此專案的所有版本預覽已停止';}catch(e:any){message.value=e.message;}finally{busy.value=false;}}
async function perform(action:string){
  if(busy.value)return;
  // Create the tab in the click handler so browsers do not block it after a build.
  const tab=action==='preview'?window.open('about:blank','_blank'):null;
  if(tab){tab.opener=null;tab.document.title='正在準備本機預覽';tab.document.body.textContent='正在安裝依賴與建置網頁，完成後會自動開啟…';}
  busy.value=true;message.value=action==='preview'?'正在準備網頁，首次安裝可能需要幾分鐘…':'';
  try{
    const result=await api(`/projects/${props.project.id}/${action}`,{...(chosen.value?{taskId:chosen.value}:{})});
    if(action==='preview'){url.value=result.url;if(tab)tab.location.replace(result.url);message.value=tab?'網頁已開啟，僅限這台電腦存取。':'網頁已啟動，請點下方連結開啟。';}
    else message.value=action==='open-folder'?'已在這台電腦開啟資料夾。':'預覽已停止。';
    await refresh();
  }catch(e:any){tab?.close();message.value=e.message;}finally{busy.value=false;}
}
</script>
<template>
  <div class="project-actions">
    <label>開啟位置<select v-model="chosen" :disabled="busy" @change="refresh"><option v-for="target in targets" :key="target.taskId||'original'" :value="target.taskId||''">{{target.label}}</option></select></label>
    <div class="project-buttons">
      <button class="secondary" :disabled="busy" @click="perform('open-folder')"><Folder :size="15"/>開啟資料夾</button>
      <button class="secondary" :disabled="busy||!targets.find(t=>(t.taskId||'')===chosen)?.web" @click="perform('preview')"><LoaderCircle v-if="busy" class="spin" :size="15"/><ExternalLink v-else :size="15"/>{{url?'開啟網頁':'啟動並開啟網頁'}}</button>
      <button v-if="store.user?.role==='admin'" class="secondary" :disabled="busy" @click="stopAll"><Square :size="14"/>停止所有預覽</button>
      <button v-if="url" class="secondary" :disabled="busy" @click="perform('preview/stop')"><Square :size="14"/>停止預覽</button>
    </div>
    <ul v-if="runtime" class="runtime-services">
      <li v-for="service in runtime.services" :key="service.id">
        <strong>{{service.id}}</strong>
        <span class="kind">{{service.type}}{{service.browserEntry?'．瀏覽器入口':''}}</span>
        <span class="state" :class="service.status==='READY'?'ready':'bad'">{{service.status}}</span>
        <span class="kind">{{service.url||'—'}}{{service.pid?`．PID ${service.pid}`:'．TaskFlow 自管'}}</span>
        <small v-if="service.error" class="error-text">{{service.failureKind}}：{{service.error}}</small>
      </li>
    </ul>
    <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer">{{url}} ↗</a>
    <small v-if="!targets.find(t=>(t.taskId||'')===chosen)?.web">尚未找到 Vue／Vite 或純 HTML 網頁，可切換到 AI 工作副本。</small>
    <small role="status">{{message}}</small>
  </div>
</template>
<style scoped>
.project-actions{flex-basis:100%;padding-left:31px;min-width:0}.project-actions label{display:block;max-width:620px;font-size:.75rem;margin:0 0 10px}.project-actions select{width:100%;margin-top:5px}.project-buttons{display:flex;flex-wrap:wrap;gap:8px}.project-actions small,.project-actions a{display:block;margin-top:8px;overflow-wrap:anywhere}.project-actions a{font-size:.8rem}.project-actions .secondary{font-size:.8rem;padding:8px 12px}
</style>
