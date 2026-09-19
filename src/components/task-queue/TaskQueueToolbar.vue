<script setup lang="ts">
// 佇列工具列：篩選與搜尋。
// 篩選條件沿用原本的「全部／執行中／已完成」，補上規格要求的「待處理／排隊中」；
// 每個條件旁邊的數字是真的算過的任務數（src/plan-group.js 的 filterCounts）。
import {computed} from 'vue';
import {ChevronsDownUp,ChevronsUpDown,Search} from 'lucide-vue-next';
import {QUEUE_FILTERS,filterCounts} from '../../plan-group.js';

const props=defineProps<{filter:string;query:string;tasks:any[];allExpanded:boolean}>();
defineEmits<{'update:filter':[value:string];'update:query':[value:string];'toggle-all':[]}>();
const counts=computed(()=>filterCounts(props.tasks));
const filters=QUEUE_FILTERS;
</script>

<template>
  <div class="toolbar queue-toolbar">
    <div class="filter-tabs" role="tablist" aria-label="任務篩選">
      <button
        v-for="item in filters"
        :key="item.value"
        role="tab"
        :aria-selected="filter===item.value"
        :class="{selected:filter===item.value}"
        @click="$emit('update:filter',item.value)"
      >{{item.label}} <span>{{counts[item.value]}}</span></button>
    </div>
    <div class="queue-toolbar-right">
      <button class="secondary compact" type="button" @click="$emit('toggle-all')">
        <component :is="allExpanded?ChevronsDownUp:ChevronsUpDown" :size="15"/>{{allExpanded?'全部收合':'全部展開'}}
      </button>
      <label class="search">
        <Search :size="17"/>
        <input :value="query" placeholder="搜尋方案、任務、專案或成員" aria-label="搜尋任務" @input="$emit('update:query',($event.target as HTMLInputElement).value)">
      </label>
    </div>
  </div>
</template>
