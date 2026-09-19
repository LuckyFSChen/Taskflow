<script setup lang="ts">
// 帳號：目前登入者、密碼、工作階段安全性，以及成員與專案授權（管理者）。
import {computed,reactive,ref} from 'vue';
import {ShieldCheck,Users} from 'lucide-vue-next';
import {api,useTaskStore} from '../../store';

const props=defineProps<{busy:boolean;users:any[];run:(fn:()=>Promise<any>)=>Promise<void>;notify:(message:string)=>void}>();
const emit=defineEmits<{'reload-users':[]}>();

const store=useTaskStore();
const isAdmin=computed(()=>store.user?.role==='admin');
const editingPassword=ref(false),addingMember=ref(false);
const passwordForm=reactive({current:'',password:''});
const memberForm=reactive({name:'',username:'',password:'',projectIds:[] as string[]});

async function savePassword(){
  await props.run(async()=>{
    await api('/account/password',passwordForm);
    passwordForm.current='';passwordForm.password='';
    editingPassword.value=false;
    props.notify('密碼已更新，其他裝置的登入已同時登出');
  });
}
async function addMember(){
  await props.run(async()=>{
    await api('/admin/users',memberForm);
    Object.assign(memberForm,{name:'',username:'',password:'',projectIds:[]});
    addingMember.value=false;
    emit('reload-users');
    props.notify('成員已建立；請在上方分配專案');
  });
}
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="account-identity">
        <span class="avatar">{{store.user?.name?.slice(0,1)}}</span>
        <div class="grow"><strong>{{store.user?.name}}</strong><small>{{store.user?.username}} · {{isAdmin?'工作空間管理者':'工作空間成員'}}</small></div>
      </div>
      <div class="setting-line">
        <div class="setting-line-text">
          <strong>密碼</strong>
          <small>變更密碼會登出這個帳號在其他裝置上的工作階段；目前這一個會保留。</small>
        </div>
        <button type="button" class="setting-value" :aria-expanded="editingPassword" @click="editingPassword=!editingPassword">
          <span class="value-text">變更密碼</span><span aria-hidden="true">›</span>
        </button>
      </div>
      <form v-if="editingPassword" class="setting-editor" @submit.prevent="savePassword">
        <label>目前密碼<input v-model="passwordForm.current" type="password" autocomplete="current-password" required></label>
        <label>新密碼<input v-model="passwordForm.password" type="password" autocomplete="new-password" minlength="12" placeholder="至少 12 字元" required></label>
        <div class="editor-actions">
          <button type="button" class="secondary compact" @click="editingPassword=false;passwordForm.current='';passwordForm.password=''">取消</button>
          <button class="primary compact" :disabled="props.busy">更新密碼</button>
        </div>
      </form>
      <div class="setting-line">
        <div class="setting-line-text">
          <strong>工作階段</strong>
          <small>登入後 12 小時自動失效，Cookie 僅限本機同源使用。登出會立即作廢目前的工作階段。</small>
        </div>
        <span class="value-text">12 小時</span>
      </div>
    </section>

    <section v-if="isAdmin" class="surface-card">
      <div class="card-head">
        <div><h2><Users :size="18"/>成員與專案授權</h2><p>成員只看得到被授權的專案與自己的任務；管理者看得到全部。</p></div>
        <button type="button" class="secondary compact" @click="addingMember=!addingMember">新增成員</button>
      </div>
      <form v-if="addingMember" class="setting-editor" @submit.prevent="addMember">
        <div class="editor-grid">
          <label>姓名<input v-model="memberForm.name" required></label>
          <label>帳號<input v-model="memberForm.username" pattern="[a-zA-Z0-9_-]{3,40}" required></label>
        </div>
        <label>初始密碼<input v-model="memberForm.password" type="password" minlength="12" autocomplete="new-password" placeholder="至少 12 字元" required></label>
        <div class="editor-actions">
          <button type="button" class="secondary compact" @click="addingMember=false">取消</button>
          <button class="primary compact" :disabled="props.busy">新增成員</button>
        </div>
      </form>
      <div v-for="u in props.users" :key="u.id" class="member-row">
        <span class="avatar">{{u.name.slice(0,1)}}</span>
        <div><strong>{{u.name}}</strong><small>{{u.username}} · {{u.role==='admin'?'管理者':'成員'}}</small></div>
        <div v-if="u.role!=='admin'" class="member-projects">
          <label v-for="p in store.projects" :key="p.id">
            <input v-model="u.projectIds" type="checkbox" :value="p.id" @change="props.run(()=>api(`/admin/users/${u.id}/projects`,{projectIds:u.projectIds}))">{{p.name}}
          </label>
        </div>
      </div>
      <p v-if="!props.users.length" class="muted">尚未讀取成員清單。</p>
    </section>

    <section class="surface-card">
      <div class="card-head"><div><h2><ShieldCheck :size="18"/>安全性</h2><p>這些行為是固定的，不可在介面關閉。</p></div></div>
      <ul class="boundaries">
        <li>密碼以 scrypt 加鹽雜湊保存，永遠不會回傳到瀏覽器。</li>
        <li>非 GET 請求會檢查來源網域，並要求 JSON 內容型別。</li>
        <li>連續登入失敗會在一分鐘內被限制次數。</li>
        <li>成果下載路徑受限於任務工作副本，且排除 .env、.git 與金鑰類檔案。</li>
      </ul>
    </section>
  </div>
</template>
