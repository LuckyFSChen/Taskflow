<script setup lang="ts">
// 首次設定精靈。四個步驟全部沿用既有能力，沒有第二套實作：
//   1 系統檢查    → /api/system/health（與平台設定同一份資料、同一套顯示邏輯）
//   2 專案位置    → DirectoryPicker + /api/admin/project-root（defaultProjectRoot）
//   3 AI 模式     → src/task-defaults.js，與建立任務表單、LINE 建立流程同一組安排
//   4 第一個任務  → 直接打開既有的建立任務 Modal
// 顯示與否由後端的設定狀態決定；使用者隨時可以「稍後設定」，環境問題交給首頁
// 既有的提醒持續顯示，精靈不會擋住任何人。
import {ref,computed,onMounted} from 'vue';
import {Activity,ArrowUpRight,Check,ChevronRight,Folder,LoaderCircle,Plus,ShieldCheck,X} from 'lucide-vue-next';
import {useTaskStore,api} from './store';
import DirectoryPicker from './DirectoryPicker.vue';
import {wizardSteps,stepDefinition,systemCheckItems,systemCheckSummary,stepBlocker,nextStepId,previousStepId,firstStepId,aiModeOptions,defaultAiMode,aiModeDescription} from './onboarding-view.js';
import {AUTO} from './task-defaults.js';

const emit=defineEmits<{close:[];'create-task':[string]}>();
const store=useTaskStore();
const dialog=ref<HTMLDialogElement>();
const stepId=ref(firstStepId());
const aiMode=ref(defaultAiMode());
const taskType=ref('code');
const picking=ref(false),busy=ref(false),error=ref('');
const context=computed(()=>({health:store.health,defaultProjectRoot:store.defaultProjectRoot,hasProject:store.projects.length>0,hasTask:store.tasks.length>0,aiMode:aiMode.value}));
const steps=computed(()=>wizardSteps(stepId.value,context.value));
const current=computed(()=>stepDefinition(stepId.value));
const checks=computed(()=>systemCheckItems(store.health));
const summary=computed(()=>systemCheckSummary(store.health));
const blocker=computed(()=>stepBlocker(stepId.value,context.value));
const isLast=computed(()=>nextStepId(stepId.value)===null);
const aiModes=aiModeOptions();

function back(){const previous=previousStepId(stepId.value);if(previous)stepId.value=previous;}
function forward(){if(blocker.value)return;const next=nextStepId(stepId.value);if(next)stepId.value=next;}
function close(){dialog.value?.close();emit('close');}
// 完成與「稍後設定」記錄的是同一件事：使用者已經看過並自己做了決定。
async function record(){busy.value=true;try{await store.completeOnboarding();}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
async function later(){await record();close();}
async function finish(){await record();emit('create-task',aiMode.value);close();}
async function saveRoot(path:string){
  picking.value=false;busy.value=true;error.value='';
  try{await api('/admin/project-root',{path});await store.refresh();}catch(e:any){error.value=e.message;}finally{busy.value=false;}
}
onMounted(()=>{dialog.value?.showModal();void store.loadHealth();});
</script>

<template>
  <DirectoryPicker v-if="picking" title="選擇預設專案存放位置" :initial-path="store.defaultProjectRoot" @close="picking=false" @select="saveRoot"/>
  <dialog ref="dialog" class="onboarding-wizard" aria-labelledby="wizard-title" @cancel.prevent="later">
    <header>
      <div><span class="eyebrow">FIRST RUN SETUP</span><h2 id="wizard-title">開始使用 TaskFlow</h2><p>四個步驟就能發出第一個任務；每一步都可以稍後再設定。</p></div>
      <button type="button" class="icon-button" aria-label="稍後設定並關閉" @click="later"><X :size="20"/></button>
    </header>

    <ol class="wizard-steps">
      <li v-for="step in steps" :key="step.id" :class="step.state">
        <span class="wizard-mark" aria-hidden="true"><Check v-if="step.done&&!step.current" :size="14"/><template v-else>{{step.index}}</template></span>
        <span>{{step.label}}</span>
      </li>
    </ol>

    <section class="wizard-body">
      <h3>{{current?.heading}}</h3>
      <p class="subtle">{{current?.description}}</p>
      <p v-if="error" class="error-text" role="alert">{{error}}</p>

      <!-- 1 系統檢查：資料與平台設定的「系統狀態」完全相同，這裡沒有第二套檢查。 -->
      <template v-if="stepId==='system'">
        <div class="wizard-checks" :aria-busy="store.healthLoading">
          <div v-for="item in checks" :key="item.key" class="health-item" :class="item.status">
            <i class="health-mark">{{item.mark}}</i>
            <div><strong>{{item.label}}</strong><small>{{item.message}}</small></div>
          </div>
          <p v-if="!checks.length" class="subtle"><LoaderCircle v-if="store.healthLoading" class="spin" :size="16"/> 尚未取得系統狀態。</p>
        </div>
        <p v-if="store.healthError" class="error-text">{{store.healthError}}</p>
        <p class="subtle">{{summary.note}}</p>
        <div class="wizard-inline">
          <button type="button" class="secondary compact" :disabled="store.healthLoading" @click="store.loadHealth(true)"><Activity :size="15"/>重新檢查</button>
          <small>專案路徑與 LINE 等其餘檢查，仍可在平台設定的「系統狀態」查看。</small>
        </div>
      </template>

      <!-- 2 專案位置：沿用既有的資料夾選擇器與既有的設定 API。 -->
      <template v-else-if="stepId==='project'">
        <div class="wizard-field">
          <span class="field-label">預設專案存放位置</span>
          <div class="project-directory-field">
            <input :value="store.defaultProjectRoot" placeholder="尚未設定" readonly @click="picking=true">
            <button type="button" class="secondary" :disabled="busy" @click="picking=true"><Folder :size="16"/>選擇資料夾</button>
          </div>
        </div>
        <p class="subtle">之後用任務標題建立的新專案都會放在這裡。可以在選擇視窗內瀏覽或新增資料夾；選好後會立刻儲存，同名資料夾不會被覆蓋。</p>
        <p v-if="blocker" class="notice warning">{{blocker}}</p>
        <p v-else class="notice"><ShieldCheck :size="17"/>已設定：{{store.defaultProjectRoot}}</p>
      </template>

      <!-- 3 AI 模式：選項與說明來自 task-defaults.js，和建立任務表單同一組值。 -->
      <template v-else-if="stepId==='ai'">
        <div class="wizard-field">
          <span class="field-label">建立任務時的預設模式</span>
          <div class="choice-row">
            <label v-for="mode in aiModes" :key="mode.value" class="choice"><input v-model="aiMode" type="radio" name="wizard-ai-mode" :value="mode.value">{{mode.label}}</label>
          </div>
        </div>
        <p class="subtle">{{aiMode===AUTO?aiModeDescription(taskType):'建立任務時可在「進階設定」自行指定規劃、執行與驗證要用哪個模型。'}}</p>
        <p class="subtle">這個選擇只決定下一步表單打開時的預設值；每一次建立任務都還能改。</p>
      </template>

      <!-- 4 第一個任務：打開既有的建立任務 Modal，不是另一套建立流程。 -->
      <template v-else>
        <p>按下按鈕會打開既有的建立任務表單。你只要寫下想完成什麼，TaskFlow 會先整理計畫，經你核准後才開始執行。</p>
        <p class="subtle">送出時會在 {{store.defaultProjectRoot||'尚未設定的預設位置'}} 依任務標題建立新專案。</p>
        <button type="button" class="primary" :disabled="busy||!store.defaultProjectRoot" @click="finish"><Plus :size="17"/>建立第一個任務</button>
        <p v-if="blocker" class="notice warning">{{blocker}}</p>
      </template>
    </section>

    <footer>
      <button type="button" class="secondary compact" :disabled="busy" @click="later">稍後設定</button>
      <div class="grow"/>
      <button v-if="previousStepId(stepId)" type="button" class="secondary compact" @click="back">上一步</button>
      <button v-if="!isLast" type="button" class="primary compact" :disabled="!!blocker" @click="forward">下一步 <ChevronRight :size="16"/></button>
      <button v-else type="button" class="secondary compact" :disabled="busy" @click="later">完成，稍後再建立 <ArrowUpRight :size="15"/></button>
    </footer>
    <small class="wizard-note">選擇「稍後設定」不會停用任何功能；系統狀態若仍有問題，首頁會繼續提醒，也可以隨時從平台設定重新開啟這個精靈。</small>
  </dialog>
</template>

<style scoped>
.onboarding-wizard{border:1px solid #dce4e9;border-radius:16px;padding:24px;width:min(720px,calc(100vw - 32px));max-height:90vh;overflow:auto;color:#263947;box-shadow:0 24px 80px #10203040}
.onboarding-wizard::backdrop{background:#14263675}
.onboarding-wizard header{display:flex;justify-content:space-between;gap:15px;align-items:flex-start}
.onboarding-wizard h2{margin:4px 0 0;font-size:1.3rem}
.onboarding-wizard header p{font-size:.85rem;color:#738492;margin:6px 0 0}
.wizard-steps{display:flex;gap:8px;list-style:none;margin:18px 0 0;padding:0;flex-wrap:wrap}
.wizard-steps li{display:flex;align-items:center;gap:7px;font-size:.8rem;color:#738492;border:1px solid #e3e9ee;border-radius:999px;padding:6px 12px}
.wizard-steps li.current{color:#1f3b52;border-color:#9dc4b6;background:#edf5f1;font-weight:600}
.wizard-steps li.done{color:#3d7a5f}
.wizard-mark{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#e3e9ee;font-size:.72rem}
.wizard-steps li.current .wizard-mark{background:#3d7a5f;color:white}
.wizard-steps li.done .wizard-mark{background:#cfe6da;color:#2f5f4a}
.wizard-body{border:1px solid #e3e9ee;border-radius:12px;padding:18px;margin:18px 0 14px;min-height:210px}
.wizard-body h3{margin:0 0 6px;font-size:1.05rem}
.wizard-checks{display:grid;gap:8px;margin:14px 0}
.wizard-field{margin:14px 0}
.field-label{display:block;font-size:.8rem;color:#738492;margin-bottom:6px}
.wizard-inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px}
.onboarding-wizard footer{display:flex;gap:10px;align-items:center;border-top:1px solid #e3e9ee;padding-top:16px}
.onboarding-wizard footer .grow{flex:1}
.wizard-note{display:block;margin-top:12px;color:#738492;font-size:.78rem}
@media(max-width:600px){.onboarding-wizard{padding:16px}.onboarding-wizard footer{flex-wrap:wrap}}
</style>
