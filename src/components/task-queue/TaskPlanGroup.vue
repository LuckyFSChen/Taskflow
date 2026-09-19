<script setup lang="ts">
// 方案群組的 header 與 accordion。
//
// Header 上的每一個數字都來自 src/plan-group.js 的 groupSummary()，母體是群組裡
// 「所有」任務，不是目前篩選後的任務——否則篩「已完成」時會出現 4/4 這種假完成度。
import {computed} from 'vue';
import {ChevronRight,Folder,GitBranch,Layers} from 'lucide-vue-next';

const props=defineProps<{group:any;expanded:boolean}>();
defineEmits<{toggle:[]}>();

// 動畫 240ms，符合 220–280ms 的範圍；easing 與規格一致。
const DURATION=240;
const reduced=()=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// height 用 JS 量測：內容高度未知，純 CSS 的 max-height 猜值在任務多的時候會跳動。
// prefers-reduced-motion 時直接跳到結束狀態，不做任何過場。
function enter(el:Element,done:()=>void){
  const node=el as HTMLElement;
  if(reduced()){node.style.height='auto';done();return;}
  node.style.height='0px';node.style.opacity='0';node.style.transform='translateY(-6px)';
  void node.offsetHeight;
  node.style.height=node.scrollHeight+'px';node.style.opacity='1';node.style.transform='translateY(0)';
  setTimeout(done,DURATION);
}
function afterEnter(el:Element){const node=el as HTMLElement;node.style.height='auto';node.style.opacity='';node.style.transform='';}
function leave(el:Element,done:()=>void){
  const node=el as HTMLElement;
  if(reduced()){done();return;}
  node.style.height=node.scrollHeight+'px';node.style.opacity='1';node.style.transform='translateY(0)';
  void node.offsetHeight;
  node.style.height='0px';node.style.opacity='0';node.style.transform='translateY(-6px)';
  setTimeout(done,DURATION);
}

const summary=computed(()=>props.group.summary);
// 收合狀態要看得到的六個數字。0 也照樣列出來，使用者才知道那一格真的是 0，而不是沒算。
const stats=computed(()=>[
  {key:'total',label:'任務',value:summary.value.total},
  {key:'completed',label:'已完成',value:summary.value.completed},
  {key:'running',label:'執行中',value:summary.value.running},
  {key:'queued',label:'排隊中',value:summary.value.queued},
  {key:'attention',label:'待處理',value:summary.value.attention},
  {key:'failed',label:'失敗',value:summary.value.failed},
]);
const panelId=computed(()=>`plan-group-panel-${props.group.id}`);
</script>

<template>
  <section class="plan-group" :class="[summary.state,{open:expanded}]">
    <button
      type="button"
      class="plan-group-header"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      @click="$emit('toggle')"
    >
      <ChevronRight class="plan-group-chevron" :size="18" aria-hidden="true"/>
      <span class="plan-group-identity">
        <span class="plan-group-title">
          <component :is="group.standalone?Folder:Layers" :size="16" aria-hidden="true"/>
          <strong>{{group.name}}</strong>
        </span>
        <span class="plan-group-meta">
          <span v-if="group.projectName">{{group.projectName}}</span>
          <span v-if="group.branch" class="plan-group-branch"><GitBranch :size="13" aria-hidden="true"/>{{group.branch}}</span>
          <span v-if="group.standalone" class="muted">未歸入任何方案的任務</span>
        </span>
      </span>
      <span class="plan-group-stats">
        <span v-for="item in stats" :key="item.key" class="plan-stat" :class="[item.key,{zero:!item.value}]">
          <b>{{item.value}}</b><small>{{item.label}}</small>
        </span>
      </span>
      <span class="badge plan-group-state" :class="summary.state">{{summary.stateLabel}}</span>
    </button>
    <p v-if="group.visibleCount<summary.total" class="plan-group-filtered">
      目前條件符合 {{group.visibleCount}} / {{summary.total}} 個任務；上方數字仍是這個方案的完整狀態。
    </p>
    <Transition :css="false" @enter="enter" @after-enter="afterEnter" @leave="leave">
      <div v-show="expanded" :id="panelId" class="plan-group-panel"><div class="plan-group-body"><slot/></div></div>
    </Transition>
  </section>
</template>
