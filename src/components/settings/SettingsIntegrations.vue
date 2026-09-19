<script setup lang="ts">
// 整合：LINE 收件匣等外部服務串接。
//
// 狀態全部來自既有的 /api/state，沒有任何寫死的「已連線」。
import {computed} from 'vue';
import {MessageSquare} from 'lucide-vue-next';
import {useTaskStore} from '../../store';
import LineLinks from '../../LineLinks.vue';

const store=useTaskStore();
const integrations=computed(()=>store.integrations||{});
const state=computed(()=>integrations.value.lastSync&&!integrations.value.error?'已連線':integrations.value.lineConfigured?'待同步':'未設定');
const tone=computed(()=>integrations.value.lastSync&&!integrations.value.error?'completed':'paused');
const detail=computed(()=>integrations.value.error?String(integrations.value.error):integrations.value.lastSync?`最後同步 ${integrations.value.lastSync}`:'需在 .env 設定 INBOX_URL 與 INBOX_TOKEN。');
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="card-head"><div><h2><MessageSquare :size="18"/>LINE 收件匣</h2><p>本機關機後，AI 工作暫停；雲端收件需完成連線設定。</p></div></div>
      <div class="connection-line">
        <span class="connection-icon"><MessageSquare :size="16"/></span>
        <div class="setting-line-text"><strong>收件連線</strong><small>{{detail}}</small></div>
        <span class="badge" :class="tone">{{state}}</span>
      </div>
    </section>

    <LineLinks/>
  </div>
</template>
