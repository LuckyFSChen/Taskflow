<script setup lang="ts">
import {computed,ref} from 'vue';
import {outputIssueView} from './output-issue-view.js';
const props=defineProps<{task?:any;busy:boolean;raw?:{available:boolean;raw:string|null;sessionId?:string|null;error?:string|null;note?:string|null;truncated?:boolean}|null;recovery?:{ok:boolean;reason?:string}|null}>();
const emit=defineEmits<{recover:[];raw:[];replan:[]}>();
const view=computed(()=>outputIssueView(props.task));
const showRaw=ref(false);
function act(id:string){
  if(id==='recover')return emit('recover');
  if(id==='replan')return emit('replan');
  showRaw.value=!showRaw.value;
  if(showRaw.value)emit('raw');
}
</script>
<template>
  <section v-if="view" class="questions output-issue" aria-label="成果報告不完整">
    <h3>{{view.title}}</h3>
    <p class="prewrap">{{view.lead}}</p>

    <p>{{view.retainedTitle}}</p>
    <ul class="retained"><li v-for="item in view.retained" :key="item">✓ {{item}}</li></ul>
    <p class="no-rerun">{{view.noRerunNote}}</p>

    <template v-if="view.missing.length">
      <p>{{view.missingTitle}}</p>
      <ul class="missing"><li v-for="item in view.missing" :key="item">{{item}}</li></ul>
    </template>

    <div class="actions">
      <!-- 沒有 title：說明已經是下面的可見文字，重複放進 title 會蓋掉按鈕的無障礙名稱。 -->
      <button v-for="action in view.actions" :key="action.id" type="button"
              :class="action.id==='recover'?'primary':'secondary'"
              :disabled="busy&&action.id!=='raw'" @click="act(action.id)">{{action.label}}</button>
    </div>
    <p v-for="action in view.actions" :key="`note-${action.id}`" class="subtle">{{action.label}}：{{action.note}}</p>

    <div v-if="recovery&&!recovery.ok" class="notice warning">重新整理成果報告沒有成功，成果報告問題仍然保留；已完成的工作沒有被重新執行。</div>

    <div v-if="showRaw" class="raw-output">
      <h4>原始 AI 回傳</h4>
      <p v-if="raw&&!raw.available" class="subtle">{{raw.note||'原始回傳的保存檔已不存在。'}}</p>
      <p v-else-if="!raw" class="subtle">讀取中…</p>
      <template v-else>
        <p v-if="raw.sessionId" class="subtle">工作階段：{{raw.sessionId}}</p>
        <pre class="prewrap"><code>{{raw.raw}}</code></pre>
        <p v-if="raw.truncated" class="subtle">原始回傳過長，僅顯示前段。</p>
      </template>
    </div>

    <details class="technical">
      <summary>{{view.technical.title}}</summary>
      <p v-if="view.technical.reason" class="prewrap">{{view.technical.reason}}</p>
      <ul v-if="view.technical.issues.length"><li v-for="(item,i) in view.technical.issues" :key="i"><code>{{item}}</code></li></ul>
      <p v-for="(note,i) in view.technical.notes" :key="`n-${i}`" class="prewrap subtle">{{note}}</p>
      <pre v-if="view.technical.message" class="prewrap"><code>{{view.technical.message}}</code></pre>
    </details>
  </section>
</template>
<style scoped>
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
/* 保留清單自己帶 ✓，再加上項目符號會變成「• ✓ 原始 AI 回傳」。 */
.retained{margin:4px 0 8px;padding-left:2px;list-style:none}
.missing{margin:4px 0 8px;padding-left:20px}
.no-rerun{font-weight:600}
.raw-output pre{max-height:320px;overflow:auto;background:var(--surface-alt,#1e1e1e);color:#e6e6e6;padding:12px;border-radius:8px;word-break:break-word}
.technical{margin-top:12px}
.technical pre{max-height:240px;overflow:auto}
</style>
