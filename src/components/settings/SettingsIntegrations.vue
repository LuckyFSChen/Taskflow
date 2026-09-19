<script setup lang="ts">
// 整合：LINE、通知、Git 與 Browser 驗證環境。
//
// 上半部是一份「連線狀態」清單，資料全部來自既有的 /api/state 與 /api/system/health，
// 沒有任何寫死的「已連線」。要新增一個整合時，只要往 connections 這個陣列再加一筆，
// 版面不需要改動。
import {computed} from 'vue';
import {Activity,GitBranch,MessageSquare,Bell} from 'lucide-vue-next';
import {useTaskStore} from '../../store';
import LineLinks from '../../LineLinks.vue';
import NotificationManager from '../../NotificationManager.vue';

const store=useTaskStore();
const isAdmin=computed(()=>store.user?.role==='admin');

type Connection={key:string;icon:any;label:string;state:string;tone:string;detail:string};
const connections=computed<Connection[]>(()=>{
  const integrations=store.integrations||{};
  const git=store.health?.checks?.git;
  const list:Connection[]=[
    {
      key:'line-inbox',icon:MessageSquare,label:'LINE 收件匣',
      state:integrations.lastSync&&!integrations.error?'已連線':integrations.lineConfigured?'待同步':'未設定',
      tone:integrations.lastSync&&!integrations.error?'completed':'paused',
      detail:integrations.error?String(integrations.error):integrations.lastSync?`最後同步 ${integrations.lastSync}`:'需在 .env 設定 INBOX_URL 與 INBOX_TOKEN。',
    },
    {
      key:'line-notify',icon:Bell,label:'LINE 通知',
      state:integrations.notificationError?'傳送失敗':integrations.pendingNotifications?'等待傳送':'無待送通知',
      tone:integrations.notificationError?'failed':'completed',
      detail:integrations.notificationError
        ? `${integrations.notificationError} · ${integrations.pendingNotifications} 則尚未送出。收件連線正常不代表通知已送達。`
        : `目前有 ${integrations.pendingNotifications||0} 則等待傳送。`,
    },
    {
      key:'browser',icon:Activity,label:'Browser 驗證環境（Playwright MCP）',
      state:integrations.browser?.available?'MCP 已連線':'未就緒',
      tone:integrations.browser?.available?'completed':'paused',
      detail:integrations.browser?.available
        ? 'MCP 連線正常，不代表每次任務都已實際完成瀏覽器驗證；個別結果請看任務詳情。'
        : String(integrations.browser?.error||'尚未偵測到可用的 Browser MCP。'),
    },
    {
      key:'git',icon:GitBranch,label:'Git',
      state:git?.status==='ok'?'可使用':git?.status?'有問題':'尚未檢查',
      tone:git?.status==='ok'?'completed':git?.status?'failed':'paused',
      detail:git?.message||'切換到「系統」分頁按重新檢查，就會回報本機 Git 的版本。TaskFlow 只在專案本身的版本庫裡建立任務分支與 worktree，不連線任何遠端服務，也沒有需要在這裡設定的 GitHub 憑證。',
    },
  ];
  return list;
});
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="card-head"><div><h2>連線狀態</h2><p>全部取自本機服務目前回報的事實。狀態正常不代表每一次傳送或驗證都成功，細節請看各任務。</p></div></div>
      <div v-for="item in connections" :key="item.key" class="connection-line">
        <span class="connection-icon"><component :is="item.icon" :size="16"/></span>
        <div class="setting-line-text"><strong>{{item.label}}</strong><small>{{item.detail}}</small></div>
        <span class="badge" :class="item.tone">{{item.state}}</span>
      </div>
      <p class="subtle">本機關機後，AI 工作暫停；雲端收件需完成連線設定。</p>
    </section>

    <LineLinks/>
    <NotificationManager v-if="isAdmin"/>
  </div>
</template>
