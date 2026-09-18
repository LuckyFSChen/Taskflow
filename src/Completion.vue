<script setup lang="ts">
// 部署與驗收：把既有的 /api/tasks/:id/git/review 與 /git/decision 接到畫面上。
// 這個元件不自己判斷任何 Git 規則，全部交給 completion-view.js 依後端送來的事實推導；
// 按鈕能不能按也由那裡決定，避免 UI 比後端寬鬆。
import {computed,ref} from 'vue';
import {completionView} from './completion-view.js';
const props=defineProps<{task?:any;review?:any;busy:boolean;loading?:boolean}>();
const emit=defineEmits<{refresh:[];merge:[options:{cleanup:boolean}];rollback:[mergeCommit:string]}>();
const view=computed(()=>completionView(props.task,props.review));
// 預設勾選＝沿用後端既有預設（合併成功後移除 worktree 並刪除已合併分支）。
// 取消勾選時分支與工作副本原樣保留，之後仍可手動處理。
const cleanup=ref(true);
const confirmingRollback=ref(false);
const time=(value:string)=>value?new Date(value).toLocaleString('zh-TW',{hour12:false}):'';
</script>
<template>
  <section v-if="view" class="detail-block completion" aria-label="部署與驗收">
    <div class="section-heading">
      <h3>部署與驗收</h3>
      <span class="badge" :class="view.badgeClass">{{view.title}}</span>
    </div>
    <p class="prewrap">{{view.message}}</p>

    <!-- Git 座標：使用者要核准的是「哪一條分支的哪一個 commit 併進哪裡」。 -->
    <dl class="completion-facts">
      <div><dt>任務分支</dt><dd><code>{{view.branch.working}}</code></dd></div>
      <div><dt>正式分支</dt><dd><code>{{view.branch.base}}</code></dd></div>
      <div><dt>分支目前 commit</dt><dd><code>{{view.branch.headCommit||'—'}}</code></dd></div>
      <div><dt>分支開出時的 commit</dt><dd><code>{{view.branch.baseCommit||'—'}}</code></dd></div>
      <div v-if="view.repository"><dt>專案目錄現況</dt><dd>
        <code>{{view.repository.branch||'detached HEAD'}}</code>
        <span :class="view.repository.clean?'ok-text':'error-text'">{{view.repository.clean?'工作樹乾淨':'有未提交修改'}}</span>
      </dd></div>
      <div v-if="view.merge"><dt>Merge commit</dt><dd><code>{{view.merge.short}}</code> <small>{{time(view.merge.at)}}</small></dd></div>
    </dl>

    <ol class="progress-steps completion-stages">
      <li v-for="item in view.stages" :key="item.key" :class="item.state">
        <span class="progress-mark" aria-hidden="true">{{item.mark}}</span>
        <div class="grow"><strong>{{item.label}}</strong><small v-if="item.detail">{{item.detail}}</small></div>
        <span class="progress-state">{{item.stateLabel}}</span>
      </li>
    </ol>

    <!-- 擋住的原因逐條列出，每一條都附「所以我該做什麼」。 -->
    <template v-if="view.blockers.length">
      <h4>目前不能合併的原因</h4>
      <ul class="completion-blockers">
        <li v-for="item in view.blockers" :key="item.code">
          <strong>{{item.message}}</strong>
          <small>{{item.hint}}</small>
        </li>
      </ul>
    </template>

    <details v-if="view.commits.length" class="completion-changes">
      <summary>查看變更（{{view.commits.length}} 個 commit）</summary>
      <ul class="completion-commits">
        <li v-for="c in view.commits" :key="c.commit">
          <code>{{c.short}}</code><span class="grow">{{c.subject}}</span><small>{{time(c.at)}}</small>
        </li>
      </ul>
      <p class="subtle">逐檔內容請看「成果」分頁的檔案清單；這裡只列出這條分支上由 TaskFlow 產生的 commit。</p>
    </details>

    <template v-if="view.canMerge">
      <h4>核准後 TaskFlow 會：</h4>
      <ul class="completion-plan">
        <li>以 <code>git merge --no-ff</code> 將 <code>{{view.branch.working}}</code> 併入 <code>{{view.branch.base}}</code>，保留 merge commit</li>
        <li v-if="cleanup">合併成功後移除此任務的 git worktree，並刪除已合併的任務分支</li>
        <li v-else>保留此任務的 git worktree 與分支，不做任何清理</li>
      </ul>
      <label class="completion-option">
        <input v-model="cleanup" type="checkbox" :disabled="busy">
        合併成功後清理工作副本與已合併分支
      </label>
      <h4>TaskFlow 不會：</h4>
      <ul class="guarantees"><li v-for="item in view.guarantees" :key="item">✗ {{item}}</li></ul>
    </template>

    <div class="actions">
      <button v-if="view.canMerge" type="button" class="primary" :disabled="busy"
              @click="emit('merge',{cleanup})">核准並合併至 {{view.branch.base}}</button>
      <button v-if="view.canRollback&&!confirmingRollback" type="button" class="secondary" :disabled="busy"
              @click="confirmingRollback=true">撤銷這次合併</button>
      <template v-if="confirmingRollback">
        <button type="button" class="secondary" :disabled="busy"
                @click="emit('rollback',view.mergeCommit);confirmingRollback=false">確定撤銷（補一個反向 commit）</button>
        <button type="button" class="secondary" :disabled="busy" @click="confirmingRollback=false">取消</button>
      </template>
      <button type="button" class="secondary" :disabled="busy||loading" @click="emit('refresh')">
        {{loading?'讀取中…':'重新讀取 Git 狀態'}}
      </button>
    </div>

    <p v-if="view.repositoryError" class="error-text">{{view.repositoryError}}</p>
    <p class="subtle">{{view.scopeNote}}</p>
  </section>
</template>
<style scoped>
.completion{margin-top:12px}
.completion-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 18px;margin:10px 0}
.completion-facts div{display:flex;gap:8px;align-items:baseline;overflow-wrap:anywhere}
.completion-facts dt{margin:0;min-width:9em;font-size:.86em;opacity:.75}
.completion-facts dd{margin:0;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.completion-stages{margin:10px 0}
.completion-blockers{margin:4px 0 8px;padding-left:2px;list-style:none}
.completion-blockers li{padding:6px 0}
.completion-blockers strong{display:block}
.completion-blockers small{display:block;opacity:.8}
.completion-changes{margin:8px 0}
.completion-commits{margin:6px 0;padding-left:2px;list-style:none;max-height:240px;overflow:auto}
.completion-commits li{display:flex;gap:8px;align-items:baseline;padding:2px 0;overflow-wrap:anywhere}
.completion-plan{margin:4px 0 8px;padding-left:1.1em}
.completion-option{display:flex;gap:8px;align-items:center;margin:8px 0}
.completion-option input{width:auto}
.guarantees{margin:4px 0 8px;padding-left:2px;list-style:none}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
.ok-text{opacity:.8}
</style>
