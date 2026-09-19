<script setup lang="ts">
// 平台設定：五個分頁，不再把所有設定攤在同一頁。
//
// 這一層只負責導覽；每個分頁的內容都在自己的元件裡，而且全部沿用既有的 API 與元件
// （LineLinks／NotificationManager／SystemHealth／ProjectActions／ProjectRemoval），
// 沒有任何設定被移除，只是換了位置。
import {computed,ref} from 'vue';
import SettingsGeneral from './SettingsGeneral.vue';
import SettingsAI from './SettingsAI.vue';
import SettingsIntegrations from './SettingsIntegrations.vue';
import SettingsSystem from './SettingsSystem.vue';
import SettingsAccount from './SettingsAccount.vue';

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
  {id:'general',label:'一般'},
  {id:'ai',label:'AI 與執行'},
  {id:'integrations',label:'整合'},
  {id:'system',label:'系統'},
  {id:'account',label:'帳號'},
];
const tab=ref('general');
const index=computed(()=>Math.max(0,TABS.findIndex(item=>item.id===tab.value)));
const HINTS:Record<string,string>={
  general:'工作空間、專案存放位置與首次設定。',
  ai:'AI 執行服務、同時執行上限與各角色使用的模型。',
  integrations:'LINE、通知與 Git 等外部連線。',
  system:'執行環境檢查與 TaskFlow 版本資訊。',
  account:'目前登入的帳號、密碼與成員授權。',
};
const hint=computed(()=>HINTS[tab.value]||'');
</script>

<template>
  <div class="settings-shell">
    <div class="segmented" role="tablist" aria-label="設定分頁" :style="{'--count':TABS.length,'--index':index}">
      <i class="segmented-thumb" aria-hidden="true"/>
      <button
        v-for="item in TABS"
        :key="item.id"
        role="tab"
        type="button"
        :aria-selected="tab===item.id"
        :class="{selected:tab===item.id}"
        @click="tab=item.id"
      >{{item.label}}</button>
    </div>
    <p class="settings-hint">{{hint}}</p>

    <SettingsGeneral
      v-if="tab==='general'"
      :busy="props.busy"
      :run="props.run"
      :notify="props.notify"
      @open-wizard="emit('open-wizard')"
      @project-removed="(id:string,cleanup:string[])=>emit('project-removed',id,cleanup)"
    />
    <SettingsAI v-else-if="tab==='ai'" :busy="props.busy" :run="props.run" :notify="props.notify"/>
    <SettingsIntegrations v-else-if="tab==='integrations'"/>
    <SettingsSystem v-else-if="tab==='system'"/>
    <SettingsAccount
      v-else
      :busy="props.busy"
      :users="props.users"
      :run="props.run"
      :notify="props.notify"
      @reload-users="emit('reload-users')"
    />
  </div>
</template>
