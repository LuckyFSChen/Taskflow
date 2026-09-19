<script setup lang="ts">
// AI 模型：分成兩個互不影響的區塊。
//
// 1. Chat（一般對話）：LINE 聊天要用哪一個 Provider 與模型，可在這裡直接切換。
//    設定存在 TaskFlow 的 settings 資料表，儲存後下一則 LINE 訊息就生效，不必重啟服務。
//    Provider 不可用時會明確顯示，而且執行失敗不會自動改用另一家 AI。
// 2. Task Runner：各任務類型、各角色使用的模型安排（純唯讀的事實展示，
//    直接讀 src/task-defaults.js 的同一份對應表）。切換 Chat 不會動到這一份。
import {computed,onMounted,ref} from 'vue';
import {MessagesSquare,Sparkles} from 'lucide-vue-next';
import {api,useTaskStore} from '../../store';
import {ENGINE_LABELS,ROLE_LABELS,TASK_TYPES,taskEngineDefaults} from '../../task-defaults.js';

const props=defineProps<{busy?:boolean;run?:(fn:()=>Promise<any>)=>Promise<void>;notify?:(message:string)=>void}>();
const store=useTaskStore();
const isAdmin=computed(()=>store.user?.role==='admin');

const PROVIDERS=[{value:'codex',label:'Codex'},{value:'claude',label:'Claude'}];
const settings=ref<any>(null);
const provider=ref('codex');
const models=ref<Record<string,string>>({codex:'',claude:''});
const chatError=ref('');
const saving=ref(false);

function apply(data:any){
  settings.value=data;
  provider.value=data?.provider||'codex';
  models.value={codex:data?.models?.codex||'',claude:data?.models?.claude||''};
}
async function load(){
  try{apply(await api('/admin/chat-settings'));chatError.value='';}
  catch(error:any){chatError.value=error?.message||'目前無法取得 Chat 設定。';}
}
async function save(){
  saving.value=true;
  try{
    apply(await api('/admin/chat-settings',{provider:provider.value,models:{codex:models.value.codex||'',claude:models.value.claude||''}}));
    chatError.value='';
    props.notify?.('Chat 設定已儲存，下一則 LINE 訊息就會使用新的設定。');
  }
  catch(error:any){chatError.value=error?.message||'儲存失敗，請稍後再試。';}
  finally{saving.value=false;}
}
onMounted(()=>{if(isAdmin.value)void load();});

const health=computed(()=>settings.value?.providers||{});
const providerCards=computed(()=>PROVIDERS.map(item=>{
  const state=health.value?.[item.value];
  return {
    ...item,
    available:!!state?.available,
    label:item.label,
    cli:item.value==='codex'?'Codex CLI':'Claude Code CLI',
    mark:state?.available?'●':'○',
    status:state?.available?'已連線':'無法使用',
    tone:state?.available?'completed':'failed',
    detail:state?.available?(state.version||'可執行'):(state?.error||'尚未取得 CLI 狀態。')
  };
}));
const selected=computed(()=>providerCards.value.find(item=>item.value===provider.value));
const placeholder=computed(()=>settings.value?.recommended?.[provider.value]||'');
const modelHint=computed(()=>settings.value?.sources?.[provider.value]==='legacy'
  ?'目前沿用舊的 LINE_GPT_MODEL 設定；在這裡儲存後就改由平台設定決定。'
  :'留白表示使用該 CLI 的預設模型。可用模型會隨 CLI 版本變動，所以這裡是自由輸入。');
const dirty=computed(()=>!!settings.value&&(provider.value!==settings.value.provider
  ||(models.value.codex||'')!==(settings.value.models?.codex||'')
  ||(models.value.claude||'')!==(settings.value.models?.claude||'')));

const engineLabels=ENGINE_LABELS as Record<string,string>;
const roles=Object.entries(ROLE_LABELS) as [string,string][];
const defaultsByType=computed(()=>TASK_TYPES.map((type:{value:string;label:string})=>{
  const engines=taskEngineDefaults(type.value) as Record<string,string>;
  return {...type,engines:roles.map(([role,label])=>({role,label,engine:engineLabels[engines[role]]||engines[role]}))};
}));
</script>

<template>
  <div class="settings-stack">
    <section v-if="isAdmin" class="surface-card">
      <div class="card-head"><div><h2><MessagesSquare :size="18"/>Chat 模型</h2><p>LINE 一般對話使用的 AI。儲存後下一則訊息就生效，不需要重新啟動 TaskFlow；執行中的對話會用原本的設定跑完。</p></div></div>

      <p v-if="chatError" class="notice error">{{chatError}}</p>

      <form class="setting-editor" @submit.prevent="save">
        <label for="chat-provider">Provider</label>
        <select id="chat-provider" v-model="provider" :disabled="!settings">
          <option v-for="item in PROVIDERS" :key="item.value" :value="item.value">{{item.label}}</option>
        </select>

        <label for="chat-model">Model</label>
        <input
          id="chat-model"
          v-model.trim="models[provider]"
          type="text"
          maxlength="120"
          autocomplete="off"
          :placeholder="placeholder"
          :disabled="!settings"
        >
        <small class="subtle">{{modelHint}}</small>

        <div class="editor-actions">
          <button class="primary compact" :disabled="props.busy||saving||!settings||!dirty">儲存設定</button>
        </div>
      </form>

      <div v-for="item in providerCards" :key="item.value" class="connection-line">
        <span class="connection-icon" aria-hidden="true">{{item.mark}}</span>
        <div class="setting-line-text"><strong>{{item.cli}}</strong><small>{{item.detail}}</small></div>
        <span class="badge" :class="item.tone">{{item.status}}</span>
      </div>

      <p v-if="settings&&selected&&!selected.available" class="subtle">
        目前選擇的是 {{selected.label}}，但 {{selected.cli}} 無法使用：LINE 對話會回覆明確的錯誤訊息，不會自動改用另一個 AI。
      </p>
      <p class="subtle">Codex 與 Claude 的模型分別記住，切換 Provider 不會蓋掉另一家上次的設定。</p>
    </section>

    <section class="surface-card">
      <div class="card-head"><div><h2><Sparkles :size="18"/>AI 模式與角色安排</h2><p>建立任務時選「自動選擇」，就會依任務類型套用下面這組安排；選「自訂」可以逐一指定。這裡顯示的就是系統實際使用的預設值，與上面的 Chat 設定互不影響。</p></div></div>
      <div v-for="type in defaultsByType" :key="type.value" class="engine-row">
        <strong>{{type.label}}</strong>
        <span class="engine-chips">
          <span v-for="item in type.engines" :key="item.role" class="engine-chip"><small>{{item.label}}</small>{{item.engine}}</span>
        </span>
      </div>
      <p class="subtle">要更換某個任務的安排，請在建立任務時選「自訂」；已建立的任務可用「補充需求」重新規劃。</p>
    </section>
  </div>
</template>
