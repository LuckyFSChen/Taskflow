<script setup lang="ts">
// 平台設定：八個分類，左側導覽 + 右側內容（桌面版），窄螢幕時導覽收成上方橫向列。
//
// 這一層只負責導覽；每個分頁的內容都在自己的元件裡，而且全部沿用既有的 API 與元件
// （LineLinks／NotificationManager／SystemHealth／ProjectActions／ProjectRemoval），
// 沒有任何設定被移除，只是重新分類、換了位置。「帳號」原本自成一頁，現在併入
// 「一般」分頁內，作為其中一個子區塊（SettingsAccount 本身的卡片結構不變）。
import {computed,ref} from 'vue';
import {House,Sparkles,Zap,GitBranch,MonitorPlay,Bell,Plug,Cpu} from 'lucide-vue-next';
import SettingsGeneral from './SettingsGeneral.vue';
import SettingsAccount from './SettingsAccount.vue';
import SettingsAIModels from './SettingsAIModels.vue';
import SettingsExecution from './SettingsExecution.vue';
import SettingsGit from './SettingsGit.vue';
import SettingsPreview from './SettingsPreview.vue';
import SettingsNotifications from './SettingsNotifications.vue';
import SettingsIntegrations from './SettingsIntegrations.vue';
import SettingsAdvanced from './SettingsAdvanced.vue';

const props=defineProps<{
  busy:boolean;
  users:any[];
  run:(fn:()=>Promise<any>)=>Promise<void>;
  notify:(message:string)=>void;
}>();
const emit=defineEmits<{
  'open-wizard':[];
  'project-removed':[projectId:string,pendingCleanup:string[]];
  'reload-users':[];
}>();

const TABS=[
  {id:'general',label:'一般',icon:House,hint:'工作空間、帳號與人員、專案存放位置與首次設定。'},
  {id:'ai-models',label:'AI 模型',icon:Sparkles,hint:'各任務類型、各角色使用的 AI 模型安排。'},
  {id:'execution',label:'執行',icon:Zap,hint:'AI 自動領取任務、同時執行上限與執行邊界。'},
  {id:'git',label:'Git',icon:GitBranch,hint:'本機 Git 狀態；TaskFlow 只在專案版本庫內建立分支與 worktree。'},
  {id:'preview',label:'預覽／瀏覽器',icon:MonitorPlay,hint:'Browser 驗證環境（Playwright MCP）連線狀態。'},
  {id:'notifications',label:'通知',icon:Bell,hint:'LINE 通知傳送狀態與通知管理。'},
  {id:'integrations',label:'整合',icon:Plug,hint:'LINE 收件匣等外部服務串接。'},
  {id:'advanced',label:'進階',icon:Cpu,hint:'執行環境檢查、TaskFlow 版本與 runtime 資訊。'},
];
const tab=ref('general');
const hint=computed(()=>TABS.find(item=>item.id===tab.value)?.hint||'');
</script>

<template>
  <div class="settings-shell">
    <nav class="settings-nav" role="tablist" aria-label="設定分頁">
      <button
        v-for="item in TABS"
        :key="item.id"
        role="tab"
        type="button"
        :aria-selected="tab===item.id"
        class="settings-nav-item"
        :class="{selected:tab===item.id}"
        @click="tab=item.id"
      ><component :is="item.icon" :size="17"/><span>{{item.label}}</span></button>
    </nav>

    <div class="settings-content">
      <p class="settings-hint">{{hint}}</p>

      <template v-if="tab==='general'">
        <SettingsGeneral
          :busy="props.busy"
          :run="props.run"
          :notify="props.notify"
          @open-wizard="emit('open-wizard')"
          @project-removed="(id:string,cleanup:string[])=>emit('project-removed',id,cleanup)"
        />
        <p class="eyebrow settings-section-title">帳號與人員</p>
        <SettingsAccount
          :busy="props.busy"
          :users="props.users"
          :run="props.run"
          :notify="props.notify"
          @reload-users="emit('reload-users')"
        />
      </template>
      <SettingsAIModels v-else-if="tab==='ai-models'"/>
      <SettingsExecution v-else-if="tab==='execution'" :busy="props.busy" :run="props.run" :notify="props.notify"/>
      <SettingsGit v-else-if="tab==='git'"/>
      <SettingsPreview v-else-if="tab==='preview'"/>
      <SettingsNotifications v-else-if="tab==='notifications'"/>
      <SettingsIntegrations v-else-if="tab==='integrations'"/>
      <SettingsAdvanced v-else-if="tab==='advanced'"/>
    </div>
  </div>
</template>
