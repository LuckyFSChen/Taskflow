<script setup lang="ts">
import {computed} from 'vue';
import {gitIssueView,gitDirtyApprovalView} from './git-issue-view.js';
const props=defineProps<{task?:any;busy:boolean}>();
const emit=defineEmits<{decide:[action:string]}>();
const view=computed(()=>gitIssueView(props.task));
const approval=computed(()=>gitDirtyApprovalView(props.task));
const time=(value:string)=>new Date(value).toLocaleString('zh-TW',{hour12:false});
</script>
<template>
  <!-- 待確認：一定同時給出「發生什麼事」「TaskFlow 不會做什麼」「我可以按什麼」。 -->
  <section v-if="view" class="questions git-issue" aria-label="需要確認 Git 修改">
    <h3>{{view.title}}</h3>
    <p v-if="view.reason==='dirty_working_tree'">
      目前專案存在未提交修改，共 {{view.fileCount}} 個項目。這些是你自己的內容，TaskFlow 不會動它們。
    </p>
    <p v-else class="prewrap">{{view.message}}</p>

    <template v-if="view.files.length">
      <h4>{{view.fileCount}} 個檔案尚未提交</h4>
      <ul class="dirty-files">
        <li v-for="file in view.files" :key="file.raw">
          <code>{{file.code}}</code> <span class="path">{{file.path}}</span> <small>{{file.label}}</small>
        </li>
      </ul>
      <p v-if="view.truncated" class="subtle">清單僅顯示前 {{view.files.length}} 個項目，實際共 {{view.fileCount}} 個。</p>
    </template>

    <template v-if="view.guarantees.length">
      <h4>TaskFlow 不會：</h4>
      <ul class="guarantees"><li v-for="item in view.guarantees" :key="item">✗ {{item}}</li></ul>
    </template>

    <div class="actions">
      <button v-for="action in view.actions" :key="action.action" type="button"
              :class="action.primary?'primary':'secondary'" :disabled="busy"
              @click="emit('decide',action.action)">{{action.label}}</button>
    </div>
    <p v-if="view.approvable" class="subtle">
      「保留修改並繼續」＝我確認目前未提交修改皆為我要保留的內容，TaskFlow 可以在不刪除、不 reset、不覆蓋這些修改的前提下繼續。
      任務仍在獨立的 Git worktree 中執行，分支自最後一次 commit 開出，這些未提交修改不會被帶進任務。
    </p>
    <p class="subtle">
      「我已自行處理，重新檢查」會重新執行 <code>git status</code>；若已乾淨就解除等待，若仍有修改只會更新清單，不會重複建立待處理項目。
    </p>
  </section>

  <!-- 已確認過：留下可核對的紀錄，使用者才知道為什麼現在不再被擋住。 -->
  <section v-else-if="approval" class="notice git-approved" aria-label="已確認保留未提交修改">
    <p>
      你已於 {{time(approval.approvedAt)}} 確認保留專案目錄中的 {{approval.fileCount}} 項未提交修改；
      TaskFlow 不會 reset、clean、stash 或刪除它們。若之後又出現新的未提交修改，會再請你確認一次。
    </p>
  </section>
</template>
<style scoped>
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
.dirty-files{margin:4px 0 8px;padding-left:2px;list-style:none;max-height:260px;overflow:auto}
.dirty-files li{display:flex;gap:8px;align-items:baseline;padding:2px 0;overflow-wrap:anywhere}
.dirty-files code{min-width:2.2em}
.dirty-files .path{font-family:var(--mono,ui-monospace,monospace)}
.guarantees{margin:4px 0 8px;padding-left:2px;list-style:none}
.git-approved{margin-top:12px}
</style>
