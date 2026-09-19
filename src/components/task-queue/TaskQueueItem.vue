<script setup lang="ts">
// 佇列裡的單一任務列。
//
// 這個元件只是把原本 App.vue 裡的 .task-table-row 搬出來，能力一個都沒有少：
// 開啟 Task Detail、變更任務狀態、調整優先級、上下排序、拖曳排序都還在，
// 送出的 API 與事件也完全相同（由 App.vue 統一處理）。
import {computed} from 'vue';
import {ArrowDown,ArrowUp,FileText,GripVertical,Terminal} from 'lucide-vue-next';
import {TASK_STATE_LABELS,TASK_STATE_MARKS,taskQueueState} from '../../plan-group.js';

const props=defineProps<{task:any;busy:boolean;statusLabel:string;priorities:string[];dragging:boolean}>();
defineEmits<{open:[];status:[event:Event];priority:[event:Event];reorder:[direction:number];dragstart:[];drop:[]}>();

const state=computed(()=>taskQueueState(props.task));
const mark=computed(()=>TASK_STATE_MARKS[state.value]||TASK_STATE_MARKS.other);
const stateLabel=computed(()=>TASK_STATE_LABELS[state.value]||TASK_STATE_LABELS.other);
const percent=computed(()=>props.task.status==='completed'?100:props.task.totalSteps?Math.round(props.task.completedSteps/props.task.totalSteps*100):0);
const retryAt=computed(()=>props.task.retryAt?new Intl.DateTimeFormat('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(props.task.retryAt)):'—');
</script>

<template>
  <div
    class="task-queue-row"
    :class="[state,{dragging}]"
    draggable="true"
    @dragstart="$emit('dragstart')"
    @dragover.prevent
    @drop.prevent="$emit('drop')"
  >
    <button class="task-title" :aria-label="`開啟任務詳情：${task.title}`" @click="$emit('open')">
      <GripVertical :size="15" class="muted drag-handle" aria-hidden="true"/>
      <span class="task-state-mark" :class="state" :title="stateLabel" :aria-label="stateLabel">{{mark}}</span>
      <span class="grow">
        <strong>{{task.title}}</strong>
        <small><component :is="task.type==='research'?FileText:Terminal" :size="12" aria-hidden="true"/> {{task.projectName}} · {{task.ownerName}}</small>
        <small v-if="task.status==='rate_limited'">預計重試：{{retryAt}}</small>
      </span>
    </button>
    <select
      class="task-status-select"
      :value="task.status"
      :aria-label="'修改任務狀態：'+task.title"
      :disabled="busy"
      @change="$emit('status',$event)"
    >
      <option :value="task.status">{{statusLabel}}</option>
      <option v-if="task.status!=='completed'" value="completed">標記完成</option>
      <option v-if="task.status!=='paused'" value="paused">暫停任務</option>
      <option v-if="task.status!=='cancelled'" value="cancelled">取消任務</option>
      <option v-if="['completed','cancelled','paused','failed','waiting_input'].includes(task.status)" value="reopen">恢復處理</option>
    </select>
    <div class="progress-cell">
      <small>{{task.totalSteps?`${task.completedSteps} / ${task.totalSteps} 步驟`:'尚待規劃'}}</small>
      <div class="progress-track"><i :style="{width:percent+'%'}"/></div>
    </div>
    <select :value="task.priority" aria-label="任務優先級" @change="$emit('priority',$event)">
      <option v-for="(p,i) in priorities" :key="i" :value="i">{{p}}</option>
    </select>
    <div class="row-actions">
      <button class="icon-button" title="向前排序" @click="$emit('reorder',-1)"><ArrowUp :size="16"/></button>
      <button class="icon-button" title="向後排序" @click="$emit('reorder',1)"><ArrowDown :size="16"/></button>
    </div>
  </div>
</template>
