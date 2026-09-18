<script setup lang="ts">
import {computed} from 'vue';
import {Activity,LoaderCircle} from 'lucide-vue-next';
import {useTaskStore} from './store';
import {healthGroups,healthMark,healthStatusLabel} from './system-health-view.js';
const store=useTaskStore();
const groups=computed(()=>healthGroups(store.health));
const overall=computed(()=>store.health?.status||'unknown');
const checkedAt=computed(()=>store.health?.checkedAt?new Intl.DateTimeFormat('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(store.health.checkedAt)):'尚未檢查');
</script>

<template>
  <section class="panel settings-card wide health-card">
    <div class="health-head">
      <h2><Activity :size="20"/>系統狀態</h2>
      <div class="health-actions">
        <span class="health-overall" :class="overall"><i class="health-mark">{{healthMark(overall)}}</i>{{healthStatusLabel(overall)}}</span>
        <button class="secondary compact" :disabled="store.healthLoading" @click="store.loadHealth(true)"><LoaderCircle v-if="store.healthLoading" :size="15" class="spin"/>重新檢查</button>
      </div>
    </div>
    <p>開始工作前先確認執行環境。這裡只顯示問題與修復方向，不會自動安裝、登入或修改任何設定。</p>
    <p v-if="store.healthError" class="error-text">{{store.healthError}}</p>
    <div v-if="groups.length" class="health-groups">
      <div v-for="group in groups" :key="group.label" class="health-group">
        <span class="eyebrow">{{group.label}}</span>
        <div v-for="item in group.items" :key="item.key" class="health-item" :class="item.status">
          <i class="health-mark">{{item.mark}}</i>
          <div><strong>{{item.label}}</strong><small>{{item.message}}</small></div>
        </div>
      </div>
    </div>
    <p v-else class="subtle">尚未取得系統狀態，請按「重新檢查」。</p>
    <p class="subtle">最後檢查：{{checkedAt}}。檢查只會讀取狀態並詢問 CLI 版本，不會啟動 AI 工作。</p>
  </section>
</template>
