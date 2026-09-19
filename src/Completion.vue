<script setup lang="ts">
// 部署與驗收：把既有的 /api/tasks/:id/git/review 與 /git/decision 接到畫面上。
// 這個元件不自己判斷任何 Git 規則，全部交給 completion-view.js 依後端送來的事實推導；
// 按鈕能不能按也由那裡決定，避免 UI 比後端寬鬆。
import {computed,ref} from 'vue';
import {completionView} from './completion-view.js';
const props=defineProps<{task?:any;review?:any;busy:boolean;loading?:boolean}>();
const emit=defineEmits<{
  refresh:[];test:[];restart:[];validate:[];
  approve:[options:{restart:boolean;validate:boolean;cleanup:boolean}];
  retry:[completionId:string];cancelPipeline:[completionId:string];
  merge:[options:{cleanup:boolean}];rollback:[mergeCommit:string];
}>();
// 一次核准要跑哪些階段。重啟與部署驗收只有 TaskFlow 自己這個專案才有意義，
// 所以那兩個勾選框只在 selfProject 時出現（勾了也不會排進其他專案的流程）。
const runRestart=ref(true),runValidate=ref(true);
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

    <!-- 一次核准，依序跑完。狀態機在後端（server/completion-pipeline.js）：
         這裡只顯示它算出來的階段與結果，不做第二套判斷。 -->
    <div v-if="view.pipeline" class="completion-pipeline">
      <div class="setting-row">
        <strong>部署流程</strong>
        <span class="badge" :class="view.pipeline.toneClass">{{view.pipeline.label}}</span>
        <small v-if="view.pipeline.approvedByName">由 {{view.pipeline.approvedByName}} 核准</small>
      </div>
      <ol class="progress-steps">
        <li v-for="item in view.pipeline.stages" :key="item.key" :class="item.state">
          <span class="progress-mark" aria-hidden="true">{{item.mark}}</span>
          <div class="grow"><strong>{{item.label}}</strong><small v-if="item.note">{{item.note}}</small></div>
        </li>
      </ol>
      <p v-if="view.pipeline.running&&view.pipeline.note" class="subtle">{{view.pipeline.note}}</p>
      <template v-if="view.pipeline.failure">
        <p class="error-text">在「{{view.pipeline.failure.stage}}」停住：{{view.pipeline.failure.message}}</p>
        <p class="subtle">已完成的階段會保留，重試只會從停住的這一階段開始；已經合併的內容不會被還原。</p>
      </template>
      <div class="actions">
        <button v-if="view.pipeline.failed" type="button" class="primary" :disabled="busy"
                @click="emit('retry',view.pipeline.id)">從失敗階段重試</button>
        <button v-if="view.pipeline.running||view.pipeline.failed" type="button" class="secondary" :disabled="busy"
                @click="emit('cancelPipeline',view.pipeline.id)">停止流程</button>
      </div>
    </div>

    <!-- 一次核准就跑完全部：這是「只按一次」的入口，下面每個區塊仍可單獨執行。 -->
    <div v-if="view.canApprovePipeline" class="completion-approve">
      <h4>一次核准，依序完成</h4>
      <ol class="completion-plan">
        <li>測試比對：在 <code>{{view.branch.base}}</code> 取基準，再跑任務分支，有新增失敗就停住</li>
        <li>以 <code>git merge --no-ff</code> 併入 <code>{{view.branch.base}}</code></li>
        <li v-if="view.restart&&runRestart">重新啟動正式 TaskFlow（先建置，建置失敗不會停掉現在的服務）</li>
        <li v-if="view.restart&&runValidate">部署驗收：驗 API 並確認 Preview 程序結束</li>
        <li v-if="cleanup">清理 worktree 與已合併分支</li>
      </ol>
      <div class="completion-options">
        <label v-if="view.restart" class="completion-option">
          <input v-model="runRestart" type="checkbox" :disabled="busy"> 完成後重新啟動正式 TaskFlow
        </label>
        <label v-if="view.restart" class="completion-option">
          <input v-model="runValidate" type="checkbox" :disabled="busy"> 重啟後執行部署驗收
        </label>
        <label class="completion-option">
          <input v-model="cleanup" type="checkbox" :disabled="busy"> 全部完成後清理工作副本與分支
        </label>
      </div>
      <button type="button" class="primary" :disabled="busy"
              @click="emit('approve',{restart:runRestart,validate:runValidate,cleanup})">核准並完成</button>
      <p class="subtle">任一階段失敗都會停在那裡等你，不會繼續往下跑；已完成的階段不會重做。</p>
    </div>

    <ol class="progress-steps completion-stages">
      <li v-for="item in view.stages" :key="item.key" :class="item.state">
        <span class="progress-mark" aria-hidden="true">{{item.mark}}</span>
        <div class="grow"><strong>{{item.label}}</strong><small v-if="item.detail">{{item.detail}}</small></div>
        <span class="progress-state">{{item.stateLabel}}</span>
      </li>
    </ol>

    <!-- 測試比對：同一套測試在正式分支與任務分支各跑一次，比對失敗項目的身分。
         沒有基準的「341 pass / 3 fail」不能用來判斷有沒有 regression，所以這裡只呈現比對結論。 -->
    <div class="completion-test">
      <div class="setting-row">
        <strong>測試比對</strong>
        <span v-if="view.test?.verdictLabel" class="badge" :class="view.test.toneClass">{{view.test.verdictLabel}}</span>
        <span v-else-if="view.test?.running" class="badge queued">執行中</span>
        <span v-else-if="view.test?.interrupted" class="badge paused">已中斷</span>
        <span v-else-if="view.test?.failedToRun" class="badge failed">未能執行</span>
        <span v-else class="badge queued">尚未比對</span>
        <button v-if="view.canRunTest" type="button" class="secondary" :disabled="busy"
                @click="emit('test')">{{view.test?'重新執行測試比對':'執行測試比對'}}</button>
      </div>

      <p v-if="!view.test" class="subtle">
        會在 <code>{{view.branch.base}}</code> 取得測試基準，再於任務分支執行同一套測試，只比對「有沒有新增的失敗」。整套測試可能需要數分鐘。
      </p>
      <p v-else-if="view.test.running" class="subtle">正在執行；結果會自己更新，不必重新整理頁面。</p>
      <p v-else-if="view.test.error" class="error-text">{{view.test.error}}</p>

      <template v-if="view.test&&!view.test.running">
        <ul class="completion-test-runs">
          <li v-if="view.test.baseline">
            <span class="grow">基準 <code>{{view.test.baseline.commit||view.branch.base}}</code>{{view.test.baseline.cached?'（沿用快取）':''}}</span>
            <small v-if="view.test.baseline.ok">{{view.test.baseline.total}} 項，{{view.test.baseline.failedCount}} 項失敗</small>
            <small v-else class="error-text">{{view.test.baseline.reasonText||'無法判讀'}}</small>
          </li>
          <li v-if="view.test.current">
            <span class="grow">任務分支 <code>{{view.test.current.commit||view.branch.headCommit}}</code></span>
            <small v-if="view.test.current.ok">{{view.test.current.total}} 項，{{view.test.current.failedCount}} 項失敗</small>
            <small v-else class="error-text">{{view.test.current.reasonText||'無法判讀'}}</small>
          </li>
        </ul>
        <template v-if="view.test.newFailureCount">
          <h4>新增的失敗（{{view.test.newFailureCount}}）</h4>
          <ul class="completion-test-failures">
            <li v-for="key in view.test.newFailures" :key="key"><code>{{key}}</code></li>
          </ul>
        </template>
        <p v-if="view.test.resolvedFailureCount" class="subtle">
          另有 {{view.test.resolvedFailureCount}} 項基準上原本失敗的測試，在這條分支上通過了。
        </p>
        <p v-if="view.test.verdict==='baseline_unavailable'||view.test.verdict==='parse_failed'" class="subtle">
          這種情況不會自動擋住合併，但也不代表沒有 regression——讀不懂結果就是讀不懂，請自行判斷後再決定。
        </p>
      </template>
    </div>

    <!-- 重新啟動正式 TaskFlow：只有 TaskFlow 自己這個專案才有這一段。
         主 server 不自己殺自己；請求交給獨立的守護程式，先建置再重啟，最後驗 /api/health。 -->
    <div v-if="view.restart" class="completion-restart">
      <div class="setting-row">
        <strong>重新啟動正式 TaskFlow</strong>
        <span class="badge" :class="view.restart.toneClass">{{view.restart.label}}</span>
        <button v-if="view.canRestart" type="button" class="secondary" :disabled="busy"
                @click="emit('restart')">{{view.restart.status==='success'?'再次重新啟動':'核准重新啟動'}}</button>
      </div>
      <p v-if="view.restart.guardianNote" class="error-text">{{view.restart.guardianNote}}</p>
      <p v-else-if="view.restart.status==='none'" class="subtle">
        合併進 <code>{{view.branch.base}}</code> 的程式不會自己生效：正式服務仍在執行舊版、<code>dist/</code> 也還是舊的。
        核准後守護程式會先建置，建置成功才停機重啟，並等 <code>/api/health</code> 通過；建置失敗不會停掉現在的服務。重啟期間網頁會短暫中斷。
      </p>
      <p v-else-if="view.restart.note" class="subtle">{{view.restart.note}}</p>
      <p v-else-if="view.restart.status==='running'" class="subtle">正在建置與重新啟動；網頁可能短暫無法連線，稍後重新整理即可。</p>
      <p v-if="view.restart.error" class="error-text">{{view.restart.error}}</p>
      <p v-if="view.restart.status==='failed'&&view.restart.attempts" class="subtle">
        已嘗試 {{view.restart.attempts}} 次（上限 {{view.restart.maxAttempts}} 次），不會再自動重試，以免變成無限重啟。
      </p>
      <p v-if="view.restart.status==='success'&&view.restart.url" class="subtle">服務網址：<code>{{view.restart.url}}</code></p>
    </div>

    <!-- 部署驗收：在合併後的正式分支上開 Preview、驗 API、停掉它，並確認那個 PID 真的消失。
         三個 API 都回 200 但程序沒停掉，一樣不算通過。 -->
    <div v-if="view.merge" class="completion-validation">
      <div class="setting-row">
        <strong>部署驗收</strong>
        <span v-if="view.validation" class="badge" :class="view.validation.toneClass">{{view.validation.label}}</span>
        <span v-else class="badge queued">尚未驗收</span>
        <button v-if="view.canValidate" type="button" class="secondary" :disabled="busy"
                @click="emit('validate')">{{view.validation?'重新執行部署驗收':'執行部署驗收'}}</button>
      </div>

      <p v-if="!view.validation" class="subtle">
        會在合併後的 <code>{{view.branch.base}}</code> 上建立一個 Preview（獨立資料庫與一次性測試帳密），
        依序驗證 <code>/api/health</code>、<code>/api/login</code>、<code>/api/state</code>，
        然後停止它並確認該 PID 真的從系統上消失。不會動到正式資料，也不需要你的帳密。
      </p>
      <p v-else-if="view.validation.running" class="subtle">正在建立 Preview 並驗證；結果會自己更新。</p>
      <p v-if="view.validation?.error" class="error-text">{{view.validation.error}}</p>

      <template v-if="view.validation&&!view.validation.running&&view.validation.checks.length">
        <ul class="completion-checks">
          <li v-for="item in view.validation.checks" :key="item.name">
            <span class="check-mark" aria-hidden="true">{{item.passed?'✓':'✗'}}</span>
            <span class="grow"><code>{{item.label}}</code></span>
            <small>{{item.actual}}</small>
          </li>
        </ul>
        <ul v-if="view.validation.failedCount" class="completion-check-details">
          <li v-for="item in view.validation.checks.filter(c=>!c.passed&&c.detail)" :key="item.name">
            <strong>{{item.label}}</strong><small>{{item.detail}}</small>
          </li>
        </ul>
        <p v-if="view.validation.url" class="subtle">
          Preview：<code>{{view.validation.url}}</code>
          <template v-if="view.validation.pid"> · PID {{view.validation.pid}} {{view.validation.previewStopped?'已確認結束':'仍然存在'}}</template>
        </p>
        <p v-if="view.validation.note" class="subtle">{{view.validation.note}}</p>
      </template>
    </div>

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
.completion-pipeline{margin:10px 0;padding:10px 12px;border:1px solid var(--line,rgba(127,127,127,.25));border-radius:8px}
.completion-pipeline .setting-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.completion-approve{margin:10px 0;padding:10px 12px;border:1px solid var(--line,rgba(127,127,127,.25));border-radius:8px}
.completion-options{display:flex;flex-direction:column;gap:2px;margin:8px 0}
.completion-test{margin:10px 0;padding:10px 12px;border:1px solid var(--line,rgba(127,127,127,.25));border-radius:8px}
.completion-restart{margin:10px 0;padding:10px 12px;border:1px solid var(--line,rgba(127,127,127,.25));border-radius:8px}
.completion-validation{margin:10px 0;padding:10px 12px;border:1px solid var(--line,rgba(127,127,127,.25));border-radius:8px}
.completion-validation .setting-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.completion-checks{margin:8px 0;padding-left:2px;list-style:none}
.completion-checks li{display:flex;gap:10px;align-items:baseline;padding:2px 0;overflow-wrap:anywhere}
.completion-checks .check-mark{min-width:1.2em}
.completion-check-details{margin:4px 0 8px;padding-left:2px;list-style:none}
.completion-check-details li{padding:3px 0}
.completion-check-details small{display:block;opacity:.8}
.completion-restart .setting-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.completion-test .setting-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.completion-test-runs{margin:8px 0;padding-left:2px;list-style:none}
.completion-test-runs li{display:flex;gap:10px;align-items:baseline;padding:2px 0;overflow-wrap:anywhere}
.completion-test-failures{margin:4px 0 8px;padding-left:2px;list-style:none;max-height:200px;overflow:auto}
.completion-test-failures li{padding:2px 0;overflow-wrap:anywhere}
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
