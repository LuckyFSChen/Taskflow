<script setup lang="ts">
// 進階：執行環境檢查（Node / Claude CLI / Codex CLI / Git / Browser 驗證環境 / Runner /
// 專案路徑 / LINE）與 TaskFlow 版本、runtime 資訊。
//
// SystemHealth.vue 原封不動沿用，重新檢查的按鈕也在它裡面；這一頁只是把它放進
// 「進階」分頁，並補上後端回報的版本與 runtime。沒有任何數值是前端自己編的：
// 讀不到就顯示「尚未取得」。
import {computed,onMounted} from 'vue';
import {Cpu} from 'lucide-vue-next';
import {useTaskStore} from '../../store';
import SystemHealth from '../../SystemHealth.vue';

const store=useTaskStore();
// 進到這一頁才讀一次；系統檢查會實際呼叫 CLI，所以刻意不放進三秒輪詢。
onMounted(()=>{if(store.user)void store.loadHealth();});

const facts=computed(()=>{
  const runtime=store.health?.runtime||{};
  return [
    {label:'TaskFlow 版本',value:store.health?.version||'尚未取得'},
    {label:'Node',value:runtime.node?`v${String(runtime.node).replace(/^v/,'')}`:'尚未取得'},
    {label:'平台',value:runtime.platform&&runtime.arch?`${runtime.platform} · ${runtime.arch}`:'尚未取得'},
    {label:'最後檢查',value:store.health?.checkedAt?new Intl.DateTimeFormat('zh-TW',{dateStyle:'medium',timeStyle:'short'}).format(new Date(store.health.checkedAt)):'尚未檢查'},
  ];
});
</script>

<template>
  <div class="settings-stack">
    <SystemHealth/>
    <section class="surface-card">
      <div class="card-head"><div><h2><Cpu :size="18"/>TaskFlow 與執行環境</h2><p>這些數值由本機服務回報，用於回報問題時對照版本。</p></div></div>
      <dl class="runtime-facts">
        <template v-for="fact in facts" :key="fact.label"><dt>{{fact.label}}</dt><dd>{{fact.value}}</dd></template>
      </dl>
      <p class="subtle">版本資訊讀自 package.json；讀不到時顯示「尚未取得」，不會顯示一個推測的版本號。</p>
    </section>
  </div>
</template>
