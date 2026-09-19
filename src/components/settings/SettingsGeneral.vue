<script setup lang="ts">
// 一般：預設專案存放位置、可用專案、首次設定精靈。
//
// 每一列預設只顯示「標題 / 說明 / 目前的值」，按下去才展開編輯器——不再讓每個設定
// 永遠掛著一個輸入框。所有動作都走既有的 API，沒有新增或移除任何設定能力。
import {computed,reactive,ref} from 'vue';
import {ArrowUpRight,ChevronRight,Folder,Plus,Workflow} from 'lucide-vue-next';
import {api,useTaskStore} from '../../store';
import DirectoryPicker from '../../DirectoryPicker.vue';
import ProjectActions from '../../ProjectActions.vue';
import ProjectRemoval from '../../ProjectRemoval.vue';

const props=defineProps<{busy:boolean;run:(fn:()=>Promise<any>)=>Promise<void>;notify:(message:string)=>void}>();
const emit=defineEmits<{'open-wizard':[];'project-removed':[projectId:string,pendingCleanup:string[]]}>();

const store=useTaskStore();
const isAdmin=computed(()=>store.user?.role==='admin');
const editingRoot=ref(false),addingProject=ref(false);
const projectRootDraft=ref<string|null>(null);
const projectRootInput=computed({get:()=>projectRootDraft.value??store.defaultProjectRoot,set:(value:string)=>{projectRootDraft.value=value;}});
const projectForm=reactive({name:'',code:'',path:'',createIfMissing:true});
const pickerTarget=ref<'project'|'root'|null>(null);
function pickDirectory(path:string){
  if(pickerTarget.value==='root')projectRootInput.value=path;
  else if(pickerTarget.value==='project')projectForm.path=path;
  pickerTarget.value=null;
}

async function saveRoot(){
  await props.run(async()=>{
    const result=await api('/admin/project-root',{path:projectRootInput.value});
    projectRootDraft.value=result.path;
    editingRoot.value=false;
    props.notify('預設專案存放位置已儲存');
  });
}
async function addProject(){
  await props.run(async()=>{
    const result=await api('/admin/projects',projectForm);
    Object.assign(projectForm,{name:'',code:'',path:'',createIfMissing:true});
    addingProject.value=false;
    props.notify(result.directoryCreated?'資料夾已建立，專案已新增':'專案已新增，使用既有資料夾');
  });
}
</script>

<template>
  <div class="settings-stack">
    <DirectoryPicker
      v-if="pickerTarget&&isAdmin"
      :title="pickerTarget==='root'?'選擇預設專案存放位置':'選擇專案資料夾'"
      :initial-path="pickerTarget==='root'?projectRootInput:(projectForm.path||store.defaultProjectRoot)"
      :suggested-name="pickerTarget==='project'?projectForm.name:''"
      @close="pickerTarget=null"
      @select="pickDirectory"
    />

    <section v-if="isAdmin" class="surface-card">
      <div class="setting-line">
        <div class="setting-line-text">
          <strong>預設專案存放位置</strong>
          <small>從 LINE 或任務標題建立專案時，會以專案名稱在此位置建立資料夾。同名資料夾不會被覆蓋。</small>
        </div>
        <button type="button" class="setting-value" :aria-expanded="editingRoot" @click="editingRoot=!editingRoot">
          <span class="value-text">{{store.defaultProjectRoot||'尚未設定'}}</span><ChevronRight :size="16"/>
        </button>
      </div>
      <form v-if="editingRoot" class="setting-editor" @submit.prevent="saveRoot">
        <div class="project-directory-field">
          <input v-model="projectRootInput" placeholder="請選擇預設存放資料夾" readonly required @click="pickerTarget='root'">
          <button type="button" class="secondary" @click="pickerTarget='root'"><Folder :size="16"/>選擇資料夾</button>
        </div>
        <small class="subtle">可在選擇視窗內瀏覽或建立資料夾。電腦關機時，LINE 請求會在本機重新上線後處理。</small>
        <div class="editor-actions">
          <button type="button" class="secondary compact" @click="editingRoot=false;projectRootDraft=null">取消</button>
          <button class="primary compact" :disabled="props.busy||!projectRootInput">儲存位置</button>
        </div>
      </form>
    </section>

    <section class="surface-card">
      <div class="card-head">
        <div><h2><Folder :size="18"/>可用專案</h2><p>只有管理者能指定或建立本機資料夾。AI 使用獨立工作副本，不直接修改原專案。</p></div>
        <button v-if="isAdmin" type="button" class="secondary compact" @click="addingProject=!addingProject"><Plus :size="15"/>新增專案</button>
      </div>
      <form v-if="isAdmin&&addingProject" class="setting-editor" @submit.prevent="addProject">
        <div class="editor-grid">
          <label>專案名稱<input v-model="projectForm.name" placeholder="例如：產品官網" required></label>
          <label>專案代號<input v-model="projectForm.code" placeholder="website" pattern="[a-zA-Z0-9_-]{2,32}" required></label>
        </div>
        <label>本機資料夾
          <div class="project-directory-field">
            <input v-model="projectForm.path" placeholder="請選擇專案資料夾" readonly required @click="pickerTarget='project'">
            <button type="button" class="secondary" @click="pickerTarget='project'"><Folder :size="16"/>選擇資料夾</button>
          </div>
        </label>
        <small class="subtle">從預設位置瀏覽，也可在選擇視窗內建立新資料夾。</small>
        <div class="editor-actions">
          <button type="button" class="secondary compact" @click="addingProject=false">取消</button>
          <button class="primary compact" :disabled="props.busy">新增專案</button>
        </div>
      </form>
      <div v-for="p in store.projects" :key="p.id" class="project-row">
        <Folder :size="18"/>
        <div class="grow"><strong>{{p.name}} <code>{{p.code}}</code></strong><small>{{p.path||'已授權使用'}}</small></div>
        <ProjectRemoval v-if="isAdmin" :project="p" @removed="(id:string,cleanup:string[])=>emit('project-removed',id,cleanup)"/>
        <ProjectActions :project="p"/>
      </div>
      <p v-if="!store.projects.length" class="muted">尚無可用專案。</p>
    </section>

    <section v-if="isAdmin" class="surface-card">
      <div class="setting-line">
        <div class="setting-line-text">
          <strong><Workflow :size="16"/>首次設定精靈</strong>
          <small>四個步驟帶你完成系統檢查、專案存放位置、AI 模式，並建立第一個任務。重新開啟不會改動任何既有設定。</small>
        </div>
        <button type="button" class="secondary compact" @click="emit('open-wizard')">開啟精靈 <ArrowUpRight :size="15"/></button>
      </div>
      <p class="subtle">{{store.onboarding?.completed?'這個工作空間已完成首次設定。':'尚未完成首次設定。'}}</p>
    </section>
  </div>
</template>
