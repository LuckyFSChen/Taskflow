// 「待我處理」的單一分類入口。
//
// 目的：使用者不需要理解 TaskFlow 的內部 status，只需要知道「現在該做什麼」。
// 所有 status / 旗標的判斷都集中在這裡，Template 不再散落 if(status===...)。
//
// attentionCategory(task) 回傳 null（不需要使用者處理），或：
//   {type,title,description,action,reason,priority}
//   title       類型標題，例如「需要確認執行計畫」
//   description 該類型的固定說明（與任務無關）
//   reason      這個任務的簡短原因（取自任務資料，可能為空字串）
//   action      CTA 文字
//   priority    顯示排序，數字越小越前面

const REASON_LIMIT = 120;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 只取第一段有內容的文字並截斷；後端的錯誤訊息常常是多行的處理說明，
// 列表只需要一句話，完整內容仍在既有的 Task Drawer 裡。
function shorten(value, limit = REASON_LIMIT) {
  const line = text(value).split('\n').map(part => part.trim()).find(Boolean) || '';
  return line.length > limit ? line.slice(0, limit - 1) + '…' : line;
}

function firstQuestion(task) {
  const questions = Array.isArray(task?.questions) ? task.questions.filter(q => text(q)) : [];
  return questions.length ? shorten(`${questions[0]}${questions.length > 1 ? `（另有 ${questions.length - 1} 個問題）` : ''}`) : '';
}

// 分類的判斷順序刻意與顯示順序（priority）分開：
// manualAction / environmentIssue / outputIssue 都會讓 status 變成 waiting_input，
// 必須先判斷，才不會被歸類成一般的「等待回答」。
const RULES = [
  {
    match: task => !!task.manualAction || task.displayStatus === 'waiting_user_action',
    build: task => ({
      type: 'manual_action',
      title: task.manualAction?.commands?.length ? '需要你在本機執行指令' : '需要你完成一項本機操作',
      description: '目前的執行環境無法完成這個操作，需要你在本機處理後回報結果。',
      reason: shorten(task.manualAction?.reason),
      action: '查看操作步驟',
      priority: 5,
    }),
  },
  {
    match: task => !!task.environmentIssue,
    build: task => ({
      type: 'environment_issue',
      title: '執行環境需要處理',
      description: '套件或執行環境檢查未通過，處理完成後才會繼續已核准的步驟。',
      reason: shorten(task.environmentIssue?.report?.summary || task.environmentIssue?.message),
      action: '查看環境問題',
      priority: 6,
    }),
  },
  {
    // 列表只說明狀況，不顯示 questions: Required 這類原始欄位錯誤。
    match: task => !!task.outputIssue,
    build: () => ({
      type: 'output_issue',
      title: '成果報告不完整',
      description: 'AI 已完成工作，但回傳的成果格式缺少必要資訊。原始回傳與已完成進度都已保留，不會重新執行已完成工作。',
      // 這裡不點名任何一個按鈕：能不能「重新整理成果報告」要看該筆問題的階段與
      // 是否已經自動還原失敗過，列表拿不到那個結論，說了就可能跳進去找不到。
      reason: '原始回傳與已完成進度都已保留，請開啟任務查看可用的處理方式。',
      action: '查看處理方式',
      priority: 7,
    }),
  },
  {
    match: task => !!task.validationSkipRequest && ['waiting_input', 'awaiting_repair_approval'].includes(task.status),
    build: task => ({
      type: 'validation_skip',
      title: '驗證工具受限，需要你決定是否跳過',
      description: '驗證因工具存取失敗而無法執行，跳過的項目會記為未驗證。',
      reason: shorten(task.validationSkipRequest?.summary),
      action: '查看驗證狀況',
      priority: 4,
    }),
  },
  {
    match: task => !!task.executionApproval,
    build: task => ({
      type: 'execution_approval',
      title: '需要你核准一項操作',
      description: 'AI 在執行中遇到需要你授權的操作，核准後才會接續原步驟。',
      reason: shorten(task.executionApproval?.questions?.[0]),
      action: '查看核准請求',
      priority: 3,
    }),
  },
  {
    match: task => task.status === 'awaiting_approval',
    build: task => ({
      type: 'plan_approval',
      title: '需要確認執行計畫',
      description: 'AI 已整理完成執行方案，等待你核准。',
      reason: shorten(task.plan?.summary),
      action: '查看計畫',
      priority: 1,
    }),
  },
  {
    match: task => task.status === 'awaiting_repair_approval',
    build: task => ({
      type: 'repair_approval',
      title: '驗證未通過，AI 已提出修正方案',
      description: '驗收沒有通過，AI 已分析原因並提出修正方案，等待你核准。',
      reason: shorten(task.validationFailure?.summary || task.repairPlan?.summary),
      action: '查看修正方案',
      priority: 2,
    }),
  },
  {
    // 到這裡的 waiting_input 已排除 manualAction / environmentIssue /
    // outputIssue / executionApproval / validationSkipRequest。
    match: task => task.status === 'waiting_input',
    build: task => ({
      type: 'waiting_answer',
      title: 'AI 需要你補充資訊',
      description: 'AI 提出了問題，回答後會重新規劃並請你審核。',
      reason: firstQuestion(task),
      action: '回答問題',
      priority: 8,
    }),
  },
  {
    match: task => task.status === 'failed',
    build: task => ({
      type: 'task_failed',
      title: '任務執行失敗，需要檢查',
      description: '執行中斷且不屬於上述可直接處理的情況，需要你查看後決定下一步。',
      reason: shorten(task.error),
      action: '查看失敗原因',
      priority: 9,
    }),
  },
];

/**
 * @typedef {{type:string,title:string,description:string,reason:string,action:string,priority:number}} AttentionCategory
 * @typedef {{task:any,category:AttentionCategory}} AttentionItem
 */

/**
 * @param {any} task
 * @returns {AttentionCategory|null}
 */
export function attentionCategory(task) {
  if (!task) return null;
  const rule = RULES.find(r => r.match(task));
  return rule ? rule.build(task) : null;
}

/**
 * @param {any} task
 * @returns {boolean}
 */
export function needsAttention(task) {
  return attentionCategory(task) !== null;
}

/**
 * 依 priority、再依最後更新時間（新的在前）排序，供頁面直接使用。
 * @param {any[]} [tasks]
 * @returns {AttentionItem[]}
 */
export function attentionItems(tasks) {
  /** @type {AttentionItem[]} */
  const items = [];
  for (const task of tasks || []) {
    const category = attentionCategory(task);
    if (category) items.push({ task, category });
  }
  return items.sort((a, b) => a.category.priority - b.category.priority || Date.parse(b.task.updated || 0) - Date.parse(a.task.updated || 0));
}

/**
 * @param {any[]} [tasks]
 * @returns {number}
 */
export function attentionCount(tasks) {
  return attentionItems(tasks).length;
}
