// 任務佇列的方案群組聚合。
//
// 唯一的分組依據是 task.planGroupId（後端 plan_groups 資料表的穩定 id）。
// 這裡不看標題、不看專案名稱、不看 Git branch、不做任何字串相似度比對：
// 沒有 planGroupId 的任務（所有舊任務都是）一律是獨立任務，集中在「其他任務」，
// 絕不會被規則硬湊進某個方案。
//
// 群組的每一個數字都由真實的 task state 算出來。這裡沒有「預估完成度」，
// 也沒有任何後端預先算好的百分比：header 上看到的 6 / 4 / 1 / 1 就是真的有幾筆。

import {attentionCategory} from './attention.js';

/** 「其他任務」這個虛擬群組的 id。它不是資料庫裡的方案，只是收容獨立任務的容器。 */
export const UNGROUPED_ID = '__ungrouped__';
export const UNGROUPED_NAME = '其他任務';

/**
 * 群組 header 的狀態優先序：需要你處理 > 失敗 > 執行中 > 排隊中 > 等待整合 > 等待關閉。
 * 例：6 個任務中 4 個 completed、1 個 running、1 個等待核准 → 顯示「需要你處理」。
 * closed 刻意不在這個優先序裡：已關閉的任務不該把群組 header 標成「還有事要做」，
 * 一個群組全部關閉時會落到最後的 'idle'，和全部 cancelled 時一樣。
 */
export const GROUP_STATE_PRIORITY = ['attention', 'failed', 'running', 'queued', 'completed', 'ready_to_close'];

export const GROUP_STATE_LABELS = {
  attention: '需要你處理',
  failed: '有任務失敗',
  running: '執行中',
  queued: '排隊中',
  completed: '等待整合',
  ready_to_close: '等待關閉',
  idle: '沒有進行中的任務',
};

/** 展開後每個任務前面的記號，與規格一致。 */
export const TASK_STATE_MARKS = {
  completed: '✓',
  ready_to_close: '✓',
  closed: '✓',
  running: '→',
  attention: '!',
  failed: '!',
  queued: '○',
  other: '·',
};

export const TASK_STATE_LABELS = {
  completed: '等待整合',
  ready_to_close: '等待關閉',
  closed: '已關閉',
  running: '執行中',
  attention: '需要你處理',
  failed: '執行失敗',
  queued: '排隊中',
  other: '其他狀態',
};

/**
 * 佇列工具列的篩選條件。保留原本「全部／執行中／已完成」，補上「待處理／排隊中」，
 * 以及生命週期改造新增的「等待整合／等待關閉／已關閉」。
 *
 * 「全部」刻意不包含已關閉的任務（見 taskMatchesFilter）：closed 是任務生命週期
 * 正式結束的 archive，預設不該再出現在使用中的佇列裡；要看它們，切到「已關閉」分頁。
 * 完整歷史（原始需求、commits、merge metadata…）仍然可以在任務詳情頁查到，不是刪除。
 */
export const QUEUE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '執行中' },
  { value: 'attention', label: '待處理' },
  { value: 'queued', label: '排隊中' },
  { value: 'completed', label: '等待整合' },
  { value: 'ready_to_close', label: '等待關閉' },
  { value: 'closed', label: '已關閉' },
];

/**
 * 單一任務在佇列裡的狀態分類。
 *
 * 判斷順序是刻意的：
 *   closed / completed / cancelled 先結案——已結束或等待整合的任務不該再算成「待處理」。
 *   completed 現在是「AI 執行已結束，等待 Git 交付整合」（Execution Terminal State），
 *   不再代表任務真正結束；只有 closed 才是整個 workflow 的 terminal state。
 *   failed 排在 attentionCategory 之前，這樣「失敗」與「需要你處理」是兩個互斥的數字，
 *   header 上的 Failure 數與 Needs Attention 數不會重複計算同一個任務。
 *
 * @param {any} task
 * @returns {'completed'|'ready_to_close'|'closed'|'failed'|'attention'|'running'|'queued'|'other'}
 */
export function taskQueueState(task) {
  if (!task) return 'other';
  if (task.status === 'closed') return 'closed';
  if (task.status === 'ready_to_close') return 'ready_to_close';
  if (task.status === 'completed') return 'completed';
  if (task.status === 'cancelled') return 'other';
  if (task.status === 'failed') return 'failed';
  if (attentionCategory(task)) return 'attention';
  if (['running', 'planning', 'repair_planning'].includes(task.status)) return 'running';
  if (['queued', 'rate_limited'].includes(task.status)) return 'queued';
  // paused 與其他狀態：既不是執行中也不是排隊中，如實歸到「其他」，不灌進任何一格。
  return 'other';
}

/**
 * 群組的聚合數字。永遠以「群組裡所有任務」為母體，不受目前 filter／搜尋影響，
 * 否則篩選「已完成」時 header 會變成 4/4，看起來像整個方案做完了。
 *
 * @param {any[]} [tasks]
 * @returns {{total:number,completed:number,ready_to_close:number,closed:number,running:number,queued:number,attention:number,failed:number,other:number,state:string,stateLabel:string}}
 */
export function groupSummary(tasks) {
  const counts = { completed: 0, ready_to_close: 0, closed: 0, failed: 0, attention: 0, running: 0, queued: 0, other: 0 };
  for (const task of tasks || []) counts[taskQueueState(task)] += 1;
  const total = (tasks || []).length;
  const state = GROUP_STATE_PRIORITY.find(key => counts[key] > 0) || 'idle';
  return { ...counts, total, state, stateLabel: GROUP_STATE_LABELS[state] };
}

/**
 * 群組的 Git branch。只有在群組內所有有分支的任務都停在同一個分支時才回報，
 * 否則回 null——寧可不顯示，也不要挑一個分支當成整個方案的分支。
 *
 * @param {any[]} [tasks]
 * @returns {string|null}
 */
export function groupBranch(tasks) {
  const branches = new Set();
  for (const task of tasks || []) {
    const branch = task?.git?.workingBranch;
    if (typeof branch === 'string' && branch.trim()) branches.add(branch.trim());
  }
  return branches.size === 1 ? [...branches][0] : null;
}

/**
 * @param {any} task
 * @param {string} [filter]
 * @returns {boolean}
 */
export function taskMatchesFilter(task, filter = 'all') {
  const state = taskQueueState(task);
  // 「全部」是「使用中的任務」，不是資料庫裡的每一筆：已關閉的任務預設不出現在這裡，
  // 只在切到「已關閉」分頁時才看得到（計畫書第二十四章）。
  if (!filter || filter === 'all') return state !== 'closed';
  // 「待處理」＝ 需要你做決定或操作，包含執行失敗（失敗也要人去看）。
  if (filter === 'attention') return state === 'attention' || state === 'failed';
  return state === filter;
}

function haystack(task) {
  return [task?.title, task?.projectName, task?.ownerName, task?.planGroupName]
    .filter(value => typeof value === 'string' && value)
    .join(' ')
    .toLowerCase();
}

/**
 * @param {any} task
 * @param {string} [query]
 * @returns {boolean}
 */
export function taskMatchesQuery(task, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return haystack(task).includes(needle);
}

/**
 * 工具列上每個篩選條件的真實數量。
 * @param {any[]} [tasks]
 * @returns {Record<string,number>}
 */
export function filterCounts(tasks) {
  /** @type {Record<string,number>} */
  const counts = {};
  for (const item of QUEUE_FILTERS) counts[item.value] = (tasks || []).filter(task => taskMatchesFilter(task, item.value)).length;
  return counts;
}

/**
 * @typedef {{id:string,name:string,standalone:boolean,projectName:string|null,branch:string|null,
 *            tasks:any[],summary:ReturnType<typeof groupSummary>,visibleCount:number,
 *            nameMatched:boolean,autoExpand:boolean}} PlanGroupView
 */

/**
 * 依 planGroupId 把任務佇列分組。
 *
 * 規則：
 *   1. 先用 filter 篩 task，再決定哪些 group 顯示（group 內一個 task 都沒剩就不顯示）。
 *   2. 搜尋命中 group 內任何一個 task，該 group 顯示並標記 autoExpand。
 *   3. 搜尋命中 group 名稱本身，整個 group 的任務都算命中。
 *   4. group 的排列順序沿用傳入的任務順序（後端已依優先級／position 排好），
 *      不依狀態重排，否則使用者剛排好的順序會自己跳動。「其他任務」永遠在最後。
 *
 * @param {any[]} [tasks] 後端 /api/state 的 tasks
 * @param {any[]} [planGroups] 後端 /api/state 的 planGroups
 * @param {{filter?:string,query?:string}} [options]
 * @returns {{groups:PlanGroupView[],visibleTaskCount:number,totalTaskCount:number,filtered:boolean}}
 */
export function buildPlanGroups(tasks, planGroups, options = {}) {
  const filter = options.filter || 'all';
  const query = String(options.query || '').trim();
  const list = Array.isArray(tasks) ? tasks : [];
  const meta = new Map();
  for (const group of planGroups || []) if (group && group.id) meta.set(group.id, group);

  /** @type {Map<string,{id:string,name:string,standalone:boolean,projectName:string|null,all:any[],visible:any[]}>} */
  const buckets = new Map();
  const bucket = task => {
    const gid = task?.planGroupId || null;
    const key = gid || UNGROUPED_ID;
    if (!buckets.has(key)) {
      const info = gid ? meta.get(gid) : null;
      buckets.set(key, {
        id: key,
        // 方案沒被 /api/state 帶回來時（例如成員只看得到部分資料），沿用任務上的名稱，
        // 再不行才用一個中性的字串——但絕不改用標題去「猜」方案名稱。
        name: gid ? (info?.name || task?.planGroupName || '未命名方案') : UNGROUPED_NAME,
        standalone: !gid,
        projectName: gid ? (info?.projectName ?? task?.projectName ?? null) : null,
        all: [],
        visible: [],
      });
    }
    return buckets.get(key);
  };

  for (const task of list) bucket(task).all.push(task);

  const needle = query.toLowerCase();
  /** @type {PlanGroupView[]} */
  const groups = [];
  for (const entry of buckets.values()) {
    const nameMatched = !!needle && !entry.standalone && entry.name.toLowerCase().includes(needle);
    const passedFilter = entry.all.filter(task => taskMatchesFilter(task, filter));
    const visible = nameMatched ? passedFilter : passedFilter.filter(task => taskMatchesQuery(task, query));
    if (!visible.length) continue;
    groups.push({
      id: entry.id,
      name: entry.name,
      standalone: entry.standalone,
      projectName: entry.projectName,
      branch: groupBranch(entry.all),
      tasks: visible,
      // summary 用 entry.all：header 顯示的是這個方案真正的樣子，不是篩選後的樣子。
      summary: groupSummary(entry.all),
      visibleCount: visible.length,
      nameMatched,
      // 搜尋命中群組內的任務時自動展開，使用者不必再點一次才看得到命中的內容。
      autoExpand: !!needle && !nameMatched,
    });
  }

  groups.sort((a, b) => Number(a.standalone) - Number(b.standalone));
  return {
    groups,
    visibleTaskCount: groups.reduce((sum, group) => sum + group.visibleCount, 0),
    totalTaskCount: list.length,
    filtered: filter !== 'all' || !!query,
  };
}
