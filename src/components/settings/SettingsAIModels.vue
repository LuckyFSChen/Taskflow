<script setup lang="ts">
// AI 模型：各任務類型、各角色使用的模型安排。
//
// 純唯讀的事實展示，直接讀 src/task-defaults.js 的同一份對應表
// （建立任務表單與 LINE 流程也用它），不是另外寫死一份文案。
import {computed} from 'vue';
import {Sparkles} from 'lucide-vue-next';
import {ENGINE_LABELS,ROLE_LABELS,TASK_TYPES,taskEngineDefaults} from '../../task-defaults.js';
const engineLabels=ENGINE_LABELS as Record<string,string>;

const roles=Object.entries(ROLE_LABELS) as [string,string][];
const defaultsByType=computed(()=>TASK_TYPES.map((type:{value:string;label:string})=>{
  const engines=taskEngineDefaults(type.value) as Record<string,string>;
  return {...type,engines:roles.map(([role,label])=>({role,label,engine:engineLabels[engines[role]]||engines[role]}))};
}));
</script>

<template>
  <div class="settings-stack">
    <section class="surface-card">
      <div class="card-head"><div><h2><Sparkles :size="18"/>AI 模式與角色安排</h2><p>建立任務時選「自動選擇」，就會依任務類型套用下面這組安排；選「自訂」可以逐一指定。這裡顯示的就是系統實際使用的預設值。</p></div></div>
      <div v-for="type in defaultsByType" :key="type.value" class="engine-row">
        <strong>{{type.label}}</strong>
        <span class="engine-chips">
          <span v-for="item in type.engines" :key="item.role" class="engine-chip"><small>{{item.label}}</small>{{item.engine}}</span>
        </span>
      </div>
      <p class="subtle">要更換某個任務的安排，請在建立任務時選「自訂」；已建立的任務可用「補充需求」重新規劃。</p>
    </section>
  </div>
</template>
