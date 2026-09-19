<script setup lang="ts">
// 通知：LINE 通知傳送狀態，以及（管理者）通知管理器。
import {computed} from 'vue';
import {Bell} from 'lucide-vue-next';
import {useTaskStore} from '../../store';
import NotificationManager from '../../NotificationManager.vue';

const store=useTaskStore();
const isAdmin=computed(()=>store.user?.role==='admin');
const integrations=computed(()=>store.integrations||{});
const state=computed(()=>integrations.value.notificationError?'傳送失敗':integrations.value.pendingNotifications?'等待傳送':'無待送通知');
const tone=computed(()=>integrations.value.notificationError?'failed':'completed');
const detail=computed(()=>integrations.value.notificationError
  ? `${integrations.value.notificationError} · ${integrations.value.pendingNotifications} 則尚未送出。收件連線正常不代表通知已送達。`
  : `目前有 ${integrations.value.pendingNotifications||0} 則等待傳送。`);
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="card-head"><div><h2><Bell :size="18"/>LINE 通知</h2><p>任務需要處理或完成時，會透過 LINE 通知擁有者。</p></div></div>
      <div class="connection-line">
        <span class="connection-icon"><Bell :size="16"/></span>
        <div class="setting-line-text"><strong>通知傳送狀態</strong><small>{{detail}}</small></div>
        <span class="badge" :class="tone">{{state}}</span>
      </div>
    </section>

    <NotificationManager v-if="isAdmin"/>
  </div>
</template>
