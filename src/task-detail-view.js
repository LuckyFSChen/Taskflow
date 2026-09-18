// Task Detail 的資訊分層（與 Vue 無關，方便測試）。
//
// Phase 7 的目的不是刪掉 Debug 能力，而是把兩種讀者分開：
//   一般使用者      －－ 現在怎麼了、我要做什麼、做出了什麼
//   Agent / Developer －－ Threads、Events、Session ID、Engine、Raw Result
//
// 分頁：
//   概覽     needsMyAttention（最上方）、任務狀態、原始需求、計畫摘要、驗收條件
//   執行進度 由真實 state 推導的步驟清單
//   成果     產出檔案、驗證證據、Browser 驗證、發布核准
//   技術資訊 Threads、Events、Session ID、Engine、Raw Result、執行紀錄
//
// 這個模組只決定「顯示什麼、算哪一種狀態」。所有互動能力（manual action、
// validation skip、execution approval、repair approval、artifact、event）
// 仍然由 App.vue 原樣渲染，一個都沒有拿掉。
//
// 重要限制：progressSteps 只能依現有的真實 state 推導，不得偽造百分比，
// 也不得把「還不知道」畫成「已完成」。無法判斷的一律 pending。

export const DETAIL_TABS = [
  { id: 'overview', label: '概覽' },
  { id: 'progress', label: '執行進度' },
  { id: 'results', label: '成果' },
  { id: 'technical', label: '技術資訊' },
];

export const DEFAULT_TAB = 'overview';

// 進度標記：只有這六種，對應下面 progressSteps 推導出的 state。
export const STATE_MARKS = {
  done: '✓',
  active: '→',
  blocked: '!',
  failed: '✗',
  skipped: '—',
  pending: '○',
};

export const STATE_LABELS = {
  done: '已完成',
  active: '進行中',
  blocked: '等待你處理',
  failed: '未通過',
  skipped: '未驗證（經同意跳過）',
  pending: '尚未開始',
};

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function threads(task) {
  return list(task?.threads);
}

// --- 需要我處理的事情 ---------------------------------------------------------
//
// 與「待我處理」列表（src/attention.js）不同：列表只需要一個分類，
// 詳情頁必須把「同時成立」的每一件事都列出來，否則使用者會漏掉其中一項。
// 判斷條件刻意與 App.vue 既有的渲染條件一致，才不會出現
// 「摘要說有、往下找不到那個區塊」。

function questionsPending(task) {
  return list(task?.questions).length > 0
    && !task?.executionApproval
    && !task?.validationSkipRequest
    && !task?.manualAction;
}

const PENDING_RULES = [
  {
    id: 'git_issue',
    match: task => !!task.gitRequest,
    title: task => task.gitRequest?.title || '需要確認 Git 修改',
    description: 'Git 工作目錄需要你確認後才會繼續。TaskFlow 不會刪除、reset、clean、stash 或覆蓋你的未提交修改。',
  },
  {
    id: 'manual_action',
    match: task => !!task.manualAction,
    title: task => (list(task.manualAction?.commands).length ? '需要你在本機執行指令' : '需要你完成一項本機操作'),
    description: '目前的執行環境無法完成這個操作，需要你在本機處理後回報結果。',
  },
  {
    id: 'environment_issue',
    match: task => !!task.environmentIssue,
    title: () => '套件環境需要你處理',
    description: '環境檢查未通過，處理完成後按「核准重新檢查」才會繼續已核准的步驟。',
  },
  {
    id: 'output_issue',
    match: task => !!task.outputIssue,
    title: () => '成果報告不完整',
    description: 'AI 已完成工作，但回傳的成果格式缺少必要資訊。原始回傳與已完成進度都已保留。',
  },
  {
    id: 'validation_skip',
    match: task => !!task.validationSkipRequest,
    title: () => '驗證工具受限，需要你決定是否跳過',
    description: '驗證因工具存取失敗而無法執行，跳過的項目會記為未驗證。',
  },
  {
    id: 'execution_approval',
    match: task => !!task.executionApproval,
    title: () => '需要你核准一項操作',
    description: 'AI 在執行中遇到需要你授權的操作，核准後才會接續原步驟。',
  },
  {
    id: 'repair_approval',
    match: task => task.status === 'awaiting_repair_approval' && !!task.repairPlan,
    title: task => `第 ${task.round || 1} 輪修正方案待你核准`,
    description: '驗收沒有通過，AI 已分析原因並提出修正方案，核准後才會開始修正。',
  },
  {
    id: 'plan_approval',
    match: task => task.status === 'awaiting_approval' && !!task.plan,
    title: task => `執行計畫 v${task.planVersion} 待你核准`,
    description: 'AI 已整理完成執行方案，核准後才會加入執行佇列。',
  },
  {
    id: 'questions',
    match: questionsPending,
    title: () => 'AI 需要你補充資訊',
    description: 'AI 提出了問題，回答後會建立新版計畫並重新請你審核。',
  },
  {
    // 與「待我處理」列表的 task_failed 對齊：那邊會列出來的任務，這裡不能靜悄悄。
    id: 'task_failed',
    match: task => task.status === 'failed',
    title: () => '任務執行失敗，需要你檢查',
    description: '執行中斷且不屬於上述可直接處理的情況，需要你查看後決定下一步。',
  },
];

/**
 * 這個任務目前需要使用者處理的每一件事，依處理優先順序排列。
 * @param {any} task
 * @returns {{id:string,title:string,description:string}[]}
 */
export function pendingActions(task) {
  if (!task) return [];
  // 與「待我處理」列表一致：已取消／已完成的任務不再列出待處理事項，殘留的旗標只當成歷程。
  if (['cancelled', 'completed'].includes(task.status)) return [];
  return PENDING_RULES
    .filter(rule => rule.match(task))
    .map(rule => ({ id: rule.id, title: rule.title(task), description: rule.description }));
}

/**
 * @param {any} task
 * @returns {boolean}
 */
export function hasPendingActions(task) {
  return pendingActions(task).length > 0;
}

/**
 * 在「概覽」以外的分頁提示還有事情要處理；沒有就回傳 null。
 * @param {any} task
 * @returns {{count:number,message:string,action:string,tab:string}|null}
 */
export function pendingBanner(task) {
  const actions = pendingActions(task);
  if (!actions.length) return null;
  return {
    count: actions.length,
    message: actions.length === 1 ? actions[0].title : `有 ${actions.length} 件事需要你處理`,
    action: '前往概覽',
    tab: 'overview',
  };
}

// --- 執行進度 -----------------------------------------------------------------

function runningThread(task, phases) {
  return threads(task).find(th => phases.includes(th.phase) && th.status === 'running') || null;
}

function completedThreads(task, phase) {
  return threads(task).filter(th => th.phase === phase && th.status === 'completed');
}

function step(key, label, state, detail = '', note = '') {
  return { key, label, state, mark: STATE_MARKS[state], stateLabel: STATE_LABELS[state], detail, note };
}

// 規劃：計畫存在就是已完成，不管後來有沒有被核准。
function planStep(task) {
  if (task.plan) return step('plan', '整理需求與計畫', 'done', `計畫 v${task.planVersion}`);
  // Git 守門在規劃開始前就擋住了，這一列必須說出真正的原因，否則會看起來像「尚未開始」。
  if (task.gitRequest) return step('plan', '整理需求與計畫', 'blocked', task.gitRequest.title || '需要你確認 Git 狀態', '確認後才會開始規劃');
  if (task.status === 'planning') return step('plan', '整理需求與計畫', 'active', '正在唯讀分析需求');
  if (questionsPending(task)) return step('plan', '整理需求與計畫', 'blocked', 'AI 提出了待確認問題');
  return step('plan', '整理需求與計畫', 'pending');
}

function approvalStep(task) {
  if (task.approvedVersion && task.approvedVersion === task.planVersion) {
    return step('approval', '核准執行計畫', 'done', `已核准 v${task.approvedVersion}`);
  }
  if (task.status === 'awaiting_approval') return step('approval', '核准執行計畫', 'blocked', '等待你核准');
  return step('approval', '核准執行計畫', 'pending');
}

// 執行步驟的 state 只有三個來源：已完成的 execute thread 數量、目前是否有
// execute thread 在跑、以及任務本身是不是卡住了。沒有其他推測。
function executionSteps(task) {
  const steps = list(task.plan?.steps);
  if (!steps.length) return [];
  const done = Number.isInteger(task.completedSteps) ? task.completedSteps : 0;
  const running = runningThread(task, ['execute']);
  const blocked = !!task.manualAction || !!task.environmentIssue || !!task.executionApproval || !!task.gitRequest;
  return steps.map((planStepItem, index) => {
    const key = `step-${index}`;
    const label = text(planStepItem?.title) || `步驟 ${index + 1}`;
    const role = text(planStepItem?.role);
    if (index < done) return step(key, label, 'done', role);
    if (index > done) return step(key, label, 'pending', role);
    if (running) return step(key, label, 'active', role);
    if (blocked) return step(key, label, 'blocked', role, '需要你處理後才會繼續');
    if (task.status === 'failed') return step(key, label, 'failed', role);
    if (['queued', 'running'].includes(task.status)) return step(key, label, 'active', role, '等待派工');
    return step(key, label, 'pending', role);
  });
}

// 修正輪次只列出「真的發生過」的輪次：取自 threads 的 round，
// 再加上目前正在處理的這一輪。沒有修正就完全不出現。
function repairRounds(task) {
  const rounds = new Set(
    threads(task)
      .filter(th => ['repair_plan', 'repair'].includes(th.phase) && Number.isInteger(th.round) && th.round > 0)
      .map(th => th.round),
  );
  if (Number.isInteger(task.round) && task.round > 0) rounds.add(task.round);
  return [...rounds].sort((a, b) => a - b);
}

function repairSteps(task) {
  const steps = [];
  for (const round of repairRounds(task)) {
    const current = task.round === round;
    const planned = threads(task).some(th => th.phase === 'repair_plan' && th.round === round && th.status === 'completed');
    const repaired = threads(task).some(th => th.phase === 'repair' && th.round === round && th.status === 'completed' && th.result?.passed && !list(th.result?.questions).length);
    const planningNow = current && task.status === 'repair_planning';
    const awaitingApproval = current && task.status === 'awaiting_repair_approval';
    const repairingNow = current && !!threads(task).find(th => th.phase === 'repair' && th.round === round && th.status === 'running');

    steps.push(step(
      `repair-plan-${round}`,
      `第 ${round} 輪修正方案`,
      planningNow ? 'active' : awaitingApproval ? 'blocked' : planned ? 'done' : 'pending',
      planningNow ? '唯讀分析原因，尚未執行修正' : awaitingApproval ? '等待你核准修正方案' : '',
    ));
    steps.push(step(
      `repair-${round}`,
      `第 ${round} 輪修正`,
      repaired ? 'done' : repairingNow ? 'active' : 'pending',
    ));
  }
  return steps;
}

/**
 * 這個任務所有 thread 回報過的 Browser 驗證紀錄（只取 required 的）。
 * @param {any} task
 * @returns {{threadId:string,role:string,phase:string,validation:any}[]}
 */
export function browserValidations(task) {
  return threads(task)
    .filter(th => th.result?.browserValidation?.required)
    .map(th => ({ threadId: th.id, role: text(th.role), phase: text(th.phase), validation: th.result.browserValidation }));
}

const BROWSER_STATE = { passed: 'done', failed: 'failed', blocked: 'blocked', running: 'active', pending: 'pending', not_required: 'pending' };

// Browser 驗證這一列只有在真的有任務要求它時才出現。還沒跑過任何一步、
// 無法得知要不要驗證時，寧可不顯示，也不要先畫一個可能不存在的項目。
function browserStep(task) {
  const records = browserValidations(task);
  if (!records.length) return null;
  const latest = records.at(-1).validation;
  const state = BROWSER_STATE[latest.status] || 'pending';
  const detail = [latest.url, Number.isInteger(latest.toolCallCount) ? `工具呼叫 ${latest.toolCallCount} 次` : '']
    .filter(Boolean).join(' · ');
  return step('browser', 'Browser 驗證', state, detail, text(latest.error));
}

function reviewSteps(task) {
  const running = runningThread(task, ['review']);
  const passed = completedThreads(task, 'review').some(th => th.result?.passed === true);
  const skipped = list(task.validationSkips).some(skip => skip.planVersion === task.planVersion);
  if (task.manualCompletion) {
    return [step('review', '最終驗證', 'skipped', '任務由使用者手動完成', '手動完成不代表已通過 AI 驗證')];
  }
  if (passed) return [step('review', '最終驗證', 'done', skipped ? '部分項目經同意跳過，記為未驗證' : '')];
  if (task.validationSkipRequest) return [step('review', '最終驗證', 'blocked', '驗證工具受限，等待你決定')];
  if (running) return [step('review', '最終驗證', 'active', '正在獨立檢查驗收條件')];
  if (task.validationFailure) return [step('review', '最終驗證', 'failed', '驗收未通過，已進入修正流程')];
  return [step('review', '最終驗證', 'pending')];
}

/**
 * 進度清單。只依現有的真實 state 推導，不含任何百分比。
 * @param {any} task
 * @returns {{key:string,label:string,state:string,mark:string,stateLabel:string,detail:string,note:string}[]}
 */
export function progressSteps(task) {
  if (!task) return [];
  const browser = browserStep(task);
  return [
    planStep(task),
    approvalStep(task),
    ...executionSteps(task),
    ...repairSteps(task),
    ...(browser ? [browser] : []),
    ...reviewSteps(task),
  ];
}

/**
 * 進度摘要：只講「幾項已完成 / 共幾項」這種可以核對的事實。
 * 故意不提供百分比，避免看起來像有人算過完成度。
 * @param {any} task
 * @returns {{done:number,total:number,label:string,note:string}}
 */
export function progressSummary(task) {
  const steps = progressSteps(task);
  const done = steps.filter(s => s.state === 'done').length;
  const skipped = steps.some(s => s.state === 'skipped')
    || list(task?.validationSkips).some(skip => skip.planVersion === task?.planVersion);
  const note = task?.manualCompletion
    ? '此任務由使用者手動完成，不代表已通過 AI 驗證。'
    : skipped
      ? '有項目經你同意跳過，記為未驗證。'
      : '';
  return { done, total: steps.length, label: `${done} / ${steps.length} 個進度項目已完成`, note };
}

// --- 成果 ---------------------------------------------------------------------

/**
 * 可確認的驗證證據，依角色分組；沒有證據的 thread 不會出現。
 * @param {any} task
 * @returns {{threadId:string,role:string,phase:string,summary:string,evidence:string[]}[]}
 */
export function validationEvidence(task) {
  return threads(task)
    .filter(th => list(th.result?.evidence).length)
    .map(th => ({
      threadId: th.id,
      role: text(th.role),
      phase: text(th.phase),
      summary: text(th.result?.summary),
      evidence: list(th.result.evidence).map(text).filter(Boolean),
    }));
}

/**
 * 發布核准區塊要不要出現、現在是哪一種狀態。
 * 沒有成果版本就沒有東西可以核准，回傳 null。
 * @param {any} task
 * @returns {{approved:boolean,version:string,note:string}|null}
 */
export function publishState(task) {
  if (!task || task.status !== 'completed' || task.manualCompletion || !task.artifactVersion) return null;
  return {
    approved: !!task.publishApproval,
    version: task.artifactVersion,
    note: '核准只綁定這次成果版本，不會自動部署、合併或對外發送。',
  };
}

// --- 技術資訊 -----------------------------------------------------------------

/**
 * 「技術資訊」分頁最上面那份事實清單。值一律是字串，交給 Template 直接印。
 * @param {any} task
 * @returns {{label:string,value:string}[]}
 */
export function technicalFacts(task) {
  if (!task) return [];
  const facts = [
    { label: '任務 ID', value: text(task.id) },
    { label: '計畫版本', value: `v${task.planVersion}${task.approvedVersion ? `（已核准 v${task.approvedVersion}）` : '（尚未核准）'}` },
    { label: '規劃 / 執行 / 驗證引擎', value: `${task.planner} / ${task.executor} / ${task.reviewer}` },
    { label: '工作階段數', value: String(threads(task).length) },
    { label: '事件紀錄數', value: String(list(task.events).length) },
  ];
  if (Number.isInteger(task.round) && task.round > 0) facts.push({ label: '修正輪次', value: `第 ${task.round} 輪` });
  if (task.artifactVersion) facts.push({ label: '成果版本', value: String(task.artifactVersion) });
  if (task.workspaceKey) facts.push({ label: '工作副本', value: String(task.workspaceKey) });
  return facts;
}

/**
 * 單一 thread 的技術欄位；Raw Result 交給 Template 自己 JSON.stringify。
 * @param {any} thread
 * @returns {{label:string,value:string}[]}
 */
export function threadTechnical(thread) {
  if (!thread) return [];
  const rows = [
    { label: 'Thread ID', value: text(thread.id) },
    { label: 'Phase', value: text(thread.phase) },
    { label: 'Engine', value: text(thread.engine) },
  ];
  if (Number.isInteger(thread.version)) rows.push({ label: 'Plan version', value: `v${thread.version}` });
  if (Number.isInteger(thread.round) && thread.round > 0) rows.push({ label: 'Round', value: String(thread.round) });
  if (text(thread.sessionId)) rows.push({ label: 'Session ID', value: text(thread.sessionId) });
  return rows;
}

/**
 * 某個 thread 的執行紀錄（Events）。技術資訊分頁用，不做截斷之外的加工。
 * @param {any} task
 * @param {string} threadId
 * @param {number} [limit]
 * @returns {any[]}
 */
export function threadEvents(task, threadId, limit = 50) {
  const events = list(task?.events).filter(event => event.thread_id === threadId);
  return limit > 0 ? events.slice(-limit) : events;
}
