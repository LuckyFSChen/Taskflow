<script setup lang="ts">
// AI 與執行：執行服務、同時執行上限、各角色使用的模型，以及執行邊界。
//
// 「各角色使用的模型」是唯讀的事實展示，直接讀 src/task-defaults.js 的同一份對應表
// （建立任務表單與 LINE 流程也用它），不是另外寫死一份文案。
import {computed,ref} from 'vue';
import {Radio,ShieldCheck,Sparkles} from 'lucide-vue-next';
import {api,useTaskStore} from '../../store';
import {ENGINE_LABELS,ROLE_LABELS,TASK_TYPES,taskEngineDefaults} from '../../task-defaults.js';
const engineLabels=ENGINE_LABELS as Record<string,string>;

const props=defineProps<{busy:boolean;run:(fn:()=>Promise<any>)=>Promise<void>;notify:(message:string)=>void}>();
const store=useTaskStore();
const isAdmin=computed(()=>store.user?.role==='admin');
const editingLimit=ref(false);
const concurrencyDraft=ref<number|null>(null);
const concurrencyInput=computed({get:()=>concurrencyDraft.value??store.runner.maxConcurrent,set:(value:number)=>{concurrencyDraft.value=value;}});
const validConcurrency=computed(()=>Number.isInteger(concurrencyInput.value)&&concurrencyInput.value>=1&&concurrencyInput.value<=32);
const roles=Object.entries(ROLE_LABELS) as [string,string][];
const defaultsByType=computed(()=>TASK_TYPES.map((type:{value:string;label:string})=>{
  const engines=taskEngineDefaults(type.value) as Record<string,string>;
  return {...type,engines:roles.map(([role,label])=>({role,label,engine:engineLabels[engines[role]]||engines[role]}))};
}));

async function saveLimit(){
  await props.run(async()=>{
    await api('/admin/runner',{maxConcurrent:concurrencyInput.value});
    concurrencyDraft.value=null;
    editingLimit.value=false;
    props.notify('同時執行上限已儲存');
  });
}
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="card-head"><div><h2><Radio :size="18"/>執行服務</h2><p>開啟後，平台會使用本機 CLI 登入，依設定上限規劃並執行已核准的工作。首次使用前請確認兩個引擎已登入。</p></div></div>
      <div class="setting-line">
        <div class="setting-line-text">
          <strong>AI 自動領取任務</strong>
          <small>關閉會停止後續派工；目前的工作仍會完成。</small>
        </div>
        <button
          v-if="isAdmin"
          class="toggle"
          :class="{on:store.runner.enabled}"
          :aria-pressed="store.runner.enabled"
          aria-label="AI 自動領取任務"
          @click="props.run(()=>api('/admin/runner',{enabled:!store.runner.enabled}))"
        ><i/></button>
        <span v-else class="value-text">{{store.runner.enabled?'已啟用':'已暫停'}}</span>
      </div>
      <div class="setting-line">
        <div class="setting-line-text">
          <strong>同時執行上限</strong>
          <small>目前執行 {{store.runner.activeCount}} 個任務。調低上限不會中斷既有工作；不同任務可並行，同一任務的步驟依序執行。</small>
        </div>
        <button v-if="isAdmin" type="button" class="setting-value" :aria-expanded="editingLimit" @click="editingLimit=!editingLimit">
          <span class="value-text">{{store.runner.maxConcurrent}} 個任務</span><span aria-hidden="true">›</span>
        </button>
        <span v-else class="value-text">{{store.runner.maxConcurrent}} 個任務</span>
      </div>
      <form v-if="isAdmin&&editingLimit" class="setting-editor" @submit.prevent="saveLimit">
        <label for="runner-concurrency">同時執行上限（1–32 個任務）</label>
        <input id="runner-concurrency" v-model.number="concurrencyInput" type="number" min="1" max="32" step="1" required style="width:120px">
        <div class="editor-actions">
          <button type="button" class="secondary compact" @click="editingLimit=false;concurrencyDraft=null">取消</button>
          <button class="primary compact" :disabled="props.busy||!validConcurrency||concurrencyInput===store.runner.maxConcurrent">儲存</button>
        </div>
      </form>
    </section>

    <section class="surface-card">
      <div class="card-head"><div><h2><Sparkles :size="18"/>AI 模式與角色安排</h2><p>建立任務時選「自動選擇」，就會依任務類型套用下面這組安排；選「自訂」可以逐一指定。這裡顯示的就是系統實際使用的預設值。</p></div></div>
      <div v-for="type in defaultsByType" :key="type.value" class="engine-row">
        <strong>{{type.label}}</strong>
        <span class="engine-chips">
          <span v-for="item in type.engines" :key="item.role" class="engine-chip"><small>{{item.label}}</small>{{item.engine}}</span>
        </span>
      </div>
      <p class="subtle">要更換某個任務的安排，請在建立任務時選「自訂」；已建立的任務可用「補充需求」重新規劃。</p>
    </section>

    <section class="surface-card">
      <div class="card-head"><div><h2><ShieldCheck :size="18"/>執行邊界</h2><p>這些限制不可在介面關閉，是 TaskFlow 的固定行為。</p></div></div>
      <ul class="boundaries">
        <li>每份計畫需由任務擁有者或管理者核准。</li>
        <li>修改需求後，舊版核准失效。</li>
        <li>每輪修正需先審核方案，單次執行最多 30 分鐘。</li>
        <li>發布核准會記錄成果版本，對外發布仍需人工執行。</li>
        <li>此版本僅供可信任成員與專案使用；工作副本不等於作業系統沙箱。</li>
      </ul>
    </section>
  </div>
</template>
