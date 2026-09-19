<script setup lang="ts">
// Git：本機 Git 版本狀態。TaskFlow 只在專案本身的版本庫裡建立任務分支與 worktree，
// 不連線任何遠端服務，也沒有需要在這裡設定的憑證，所以這裡只回報一件事實。
import {computed} from 'vue';
import {GitBranch} from 'lucide-vue-next';
import {useTaskStore} from '../../store';

const store=useTaskStore();
const git=computed(()=>store.health?.checks?.git);
const state=computed(()=>git.value?.status==='ok'?'可使用':git.value?.status?'有問題':'尚未檢查');
const tone=computed(()=>git.value?.status==='ok'?'completed':git.value?.status?'failed':'paused');
const detail=computed(()=>git.value?.message||'切換到「進階」分頁按重新檢查，就會回報本機 Git 的版本。');
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="card-head"><div><h2><GitBranch :size="18"/>Git</h2><p>TaskFlow 只在專案本身的版本庫裡建立任務分支與 worktree，不連線任何遠端服務。</p></div></div>
      <div class="connection-line">
        <span class="connection-icon"><GitBranch :size="16"/></span>
        <div class="setting-line-text"><strong>本機 Git</strong><small>{{detail}}</small></div>
        <span class="badge" :class="tone">{{state}}</span>
      </div>
    </section>
  </div>
</template>
