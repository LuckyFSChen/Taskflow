<script setup lang="ts">
import {ref} from 'vue';
const props=defineProps<{request?:{id:string;reason:string;commands:string[];workingDirectory:string|null;instructions:string|null;verification:string[];requiresAdministrator:boolean|null;message?:string|null};skips?:{reason:string;commands:string[]}[];busy:boolean}>();
const emit=defineEmits<{decide:[decision:'completed'|'failed'|'skip',note?:string]}>();
const showFailForm=ref(false),note=ref('');
async function copyCommands(){
  if(!props.request)return;
  const text=[props.request.workingDirectory?`Set-Location "${props.request.workingDirectory}"`:null,...props.request.commands].filter(Boolean).join('\n');
  try{await navigator.clipboard.writeText(text);}catch{/* clipboard unavailable; user can still select the text manually */}
}
function submitFailure(){emit('decide','failed',note.value);showFailForm.value=false;note.value='';}
</script>
<template>
  <section v-if="request" class="questions manual-action" aria-label="需要你的協助">
    <h3>⚠ 需要你的協助</h3>
    <p class="prewrap">TaskFlow 目前的執行環境無法執行以下操作，但需要完成後才能繼續驗收。</p>
    <p class="prewrap">原因：{{request.reason}}</p>
    <p v-if="request.workingDirectory">工作目錄：<code>{{request.workingDirectory}}</code></p>
    <pre v-if="request.commands.length" class="command-block"><code><template v-if="request.workingDirectory">Set-Location "{{request.workingDirectory}}"
</template>{{request.commands.join('\n')}}</code></pre>
    <p v-if="request.instructions" class="prewrap">{{request.instructions}}</p>
    <p v-if="request.requiresAdministrator===true">請以系統管理員身分開啟 PowerShell。</p>
    <p v-else-if="request.requiresAdministrator===false">通常不需要系統管理員權限，請在一般 PowerShell 執行即可。</p>
    <p v-else>請先在一般 PowerShell 執行；若顯示權限不足，再改用「以系統管理員身分執行」。</p>
    <ul v-if="request.verification.length"><li v-for="(v,i) in request.verification" :key="i">{{v}}</li></ul>
    <details v-if="request.message"><summary>查看原始錯誤訊息</summary><pre class="prewrap"><code>{{request.message}}</code></pre></details>
    <div class="actions">
      <button v-if="request.commands.length" class="secondary" type="button" @click="copyCommands">複製全部指令</button>
      <button class="primary" :disabled="busy" @click="$emit('decide','completed')">我已執行完成</button>
      <button class="secondary" :disabled="busy" @click="showFailForm=!showFailForm">執行失敗</button>
      <button class="secondary" :disabled="busy" @click="$emit('decide','skip')">略過此步驟</button>
    </div>
    <form v-if="showFailForm" @submit.prevent="submitFailure">
      <label>貼上執行時看到的錯誤訊息<textarea v-model="note" rows="3" minlength="1" maxlength="4000" required/></label>
      <button class="secondary" :disabled="busy||!note.trim()">送出，交由 AI 分析</button>
    </form>
  </section>
  <section v-if="skips?.length" class="questions"><h3>有操作因執行環境限制經同意略過（未驗證）</h3><details v-for="(item,i) in skips" :key="i"><summary>查看略過原因與指令</summary><p class="prewrap">{{item.reason}}</p><p v-if="item.commands.length" class="prewrap">{{item.commands.join('\n')}}</p></details></section>
</template>
<style scoped>
.actions{display:flex;gap:12px;flex-wrap:wrap}
.command-block{background:var(--surface-alt,#1e1e1e);color:#e6e6e6;padding:12px;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
</style>
