<script setup lang="ts">
// 預覽／瀏覽器：Browser 驗證環境（Playwright MCP）的連線狀態。
import {computed} from 'vue';
import {MonitorPlay} from 'lucide-vue-next';
import {useTaskStore} from '../../store';

const store=useTaskStore();
const browser=computed(()=>store.integrations?.browser);
const state=computed(()=>browser.value?.available?'MCP 已連線':'未就緒');
const tone=computed(()=>browser.value?.available?'completed':'paused');
const detail=computed(()=>browser.value?.available
  ? 'MCP 連線正常，不代表每次任務都已實際完成瀏覽器驗證；個別結果請看任務詳情。'
  : String(browser.value?.error||'尚未偵測到可用的 Browser MCP。'));
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="card-head"><div><h2><MonitorPlay :size="18"/>Browser 驗證環境</h2><p>需要實際互動驗證的任務，會透過 Playwright MCP 開啟真實瀏覽器操作，而不是只看程式碼。</p></div></div>
      <div class="connection-line">
        <span class="connection-icon"><MonitorPlay :size="16"/></span>
        <div class="setting-line-text"><strong>Playwright MCP</strong><small>{{detail}}</small></div>
        <span class="badge" :class="tone">{{state}}</span>
      </div>
    </section>
  </div>
</template>
