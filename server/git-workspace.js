// Phase 1：用 Git 取代 v1/v2/v3 工作副本複製。
//
// 這個模組只負責「讓任務有一個安全、隔離、可追溯的工作目錄」，不負責 commit（Phase 2）
// 與 merge／rollback（Phase 3）。三個不可妥協的原則寫在程式碼裡，不是靠 prompt：
//   1. 任何會破壞使用者既有內容的 git 指令都不可能從這裡送出（assertAllowed）。
//   2. 專案有未提交修改時停止，不清、不 stash、不混進 TaskFlow 的工作（dirty_working_tree）。
//   3. Agent 永遠不會在 main／master 等受保護 branch 上執行（assertWorkingBranch）。
// Agent 實際工作的地方是 git worktree：與專案共用 .git 歷史，但工作樹完全獨立，
// 所以使用者的專案目錄不會被 agent 改到，多個任務也能同時進行。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'production', 'release', 'develop'];

// 初始 commit 不做 `git add .`：只加入通過這個檢查的項目，避免把秘密或執行期資料寫進歷史。
const UNSAFE_NAME = /^(node_modules|\.git|\.env(?:\..*)?|data|dist|build|out|coverage|\.venv|venv|\.ssh|\.aws|\.gnupg|\.codex|\.claude|\.taskflow|\.wrangler|\.dev\.vars(?:\..*)?|logs?|tmp|temp|runtime|first-login\.txt|id_rsa.*|credentials?.*|secrets?.*)$/i;
const UNSAFE_EXTENSION = /\.(pem|key|pfx|p12|crt|keystore|jks|sqlite(?:-wal|-shm)?|db|log)$/i;
export const isUnsafeToCommit = name => UNSAFE_NAME.test(name) || UNSAFE_EXTENSION.test(name);

// 新專案才會寫入；既有 .gitignore 只補不刪，使用者原本的規則一行都不動。
export const DEFAULT_IGNORE_ENTRIES = [
  'node_modules/', 'dist/', 'build/', 'coverage/', 'data/', 'logs/', 'tmp/', 'temp/',
  '.env', '.env.*', '*.log', '*.pem', '*.key', '*.pfx', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm',
];
const IGNORE_HEADER = '# 由 TaskFlow 建立：避免把秘密、相依套件與執行期資料提交進版本庫';

export class GitSafetyError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'GitSafetyError';
    this.code = 'GIT_SAFETY';
    this.reason = reason;
    this.details = details;
  }
}

// 自動化流程永遠不得執行的指令。這是白紙黑字的 denylist，不是慣例：就算之後有人在
// 別處呼叫 git()，破壞性指令一樣會在這裡被擋下來，必須由使用者自己在終端機執行。
// 例外通道：只有使用者在 Review 介面上明確做出決定（刪除被拒絕的分支、放棄一個衝突的 merge）
// 才會用到。它不是「關掉守門」，而是把名單縮到這三個指令；其餘破壞性指令在任何情況下都送不出去。
const AUTHORIZED_COMMANDS = {
  delete_rejected_branch: args => args[0] === 'branch' && (args.includes('-D') || args.includes('--delete')),
  abort_merge: args => args[0] === 'merge' && args.includes('--abort'),
  // 只有在已經逐一確認「剩下的全是 TaskFlow 自己的暫存檔」之後才會用到，見 cleanupTaskBranch。
  remove_internal_only_worktree: args => args[0] === 'worktree' && args[1] === 'remove',
};
function assertAllowed(args, authorizedAs) {
  if (authorizedAs) {
    const allow = AUTHORIZED_COMMANDS[authorizedAs];
    if (!allow) throw new GitSafetyError('forbidden_command', `未知的授權用途 ${authorizedAs}，已停止。`, {});
    if (allow(args)) return;
    throw new GitSafetyError('forbidden_command', `這個指令不在「${authorizedAs}」的授權範圍內，已停止。`, { args });
  }
  const rest = [...args];
  const flags = [];
  while (rest.length && (rest[0] === '-c' || rest[0] === '-C')) { flags.push(rest.shift()); rest.shift(); }
  const [command, ...params] = rest;
  const has = (...names) => names.some(name => params.includes(name));
  const forbidden =
    (command === 'reset' && has('--hard')) ? 'git reset --hard' :
    command === 'clean' ? 'git clean' :
    command === 'push' ? 'git push' :
    command === 'stash' ? 'git stash' :
    command === 'restore' ? 'git restore' :
    (command === 'checkout' && has('--', '.')) ? 'git checkout --' :
    (command === 'branch' && has('-D')) ? 'git branch -D' :
    (command === 'rm' && !has('--cached')) ? 'git rm' :
    (command === 'worktree' && params[0] === 'remove' && has('--force', '-f')) ? 'git worktree remove --force' :
    null;
  if (forbidden) throw new GitSafetyError('forbidden_command', `TaskFlow 自動化流程不允許執行 ${forbidden}；此操作需要你在終端機自行確認後執行。`, { command: forbidden });
}

// 同步執行，和它取代的 snapshot() 一樣：runner 在建立 thread 後、呼叫 Agent 前必須把工作目錄
// 準備好，中間不插入非同步縫隙，任務的啟動與中止時序才與既有流程一致。
export function createGitRunner({ exec = execFileSync, timeout = 120000 } = {}) {
  return function git(cwd, args, { allowFailure = false, authorizedAs = null } = {}) {
    assertAllowed(args, authorizedAs);
    try {
      const stdout = exec('git', args, { cwd, timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, stdout: String(stdout || ''), stderr: '' };
    } catch (e) {
      const result = { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), error: e };
      if (allowFailure) return result;
      throw new GitSafetyError('git_command_failed', `git ${args.join(' ')} 執行失敗：${(result.stderr || e.message).trim().slice(0, 500)}`, { args });
    }
  };
}

const samePath = (a, b) => {
  const normalize = p => resolve(p).replace(/[\\/]+$/, '');
  const [x, y] = [normalize(a), normalize(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
const firstLine = text => String(text || '').split('\n')[0].trim();

export function gitAvailable(git, cwd = process.cwd()) {
  return git(cwd, ['--version'], { allowFailure: true }).ok;
}

export function normalizeProtectedBranches(value) {
  const list = Array.isArray(value) ? value : DEFAULT_PROTECTED_BRANCHES;
  return [...new Set(list.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim().toLowerCase()))];
}
export const isProtectedBranch = (branch, protectedBranches) =>
  !!branch && normalizeProtectedBranches(protectedBranches).includes(branch.trim().toLowerCase());

// 分支名稱只由 taskId 與標題決定，且一定通過 git 的命名規則；中文標題會被整段濾掉，
// 此時仍有 taskId 前綴可以辨識，不會產生無效或空白的分支名。
export function taskBranchName({ taskId, title = '', prefix = 'taskflow' }) {
  const shortId = String(taskId || '').split('-')[0].replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'task';
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  const name = `${prefix}/${shortId}${slug ? `-${slug}` : ''}`;
  if (!/^[a-z0-9][a-z0-9._\-/]*$/i.test(name.slice(prefix.length + 1)) || name.includes('..') || name.endsWith('.lock')) {
    return `${prefix}/${shortId}`;
  }
  return name;
}

export function inspectRepository(projectPath, { git }) {
  if (!existsSync(projectPath)) throw new GitSafetyError('project_missing', `專案資料夾不存在：${projectPath}`);
  const inside = git(projectPath, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (!inside.ok || firstLine(inside.stdout) !== 'true') return { isRepository: false, repositoryPath: null, nested: false };
  const top = git(projectPath, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  const repositoryPath = top.ok ? resolve(firstLine(top.stdout)) : resolve(projectPath);
  const branchResult = git(repositoryPath, ['branch', '--show-current'], { allowFailure: true });
  const headResult = git(repositoryPath, ['rev-parse', 'HEAD'], { allowFailure: true });
  const statusResult = git(repositoryPath, ['status', '--porcelain'], { allowFailure: true });
  return {
    isRepository: true,
    repositoryPath,
    nested: !samePath(repositoryPath, projectPath),
    branch: branchResult.ok ? firstLine(branchResult.stdout) || null : null,
    head: headResult.ok ? firstLine(headResult.stdout) || null : null,
    dirty: statusResult.ok ? statusResult.stdout.split('\n').map(line => line.trim()).filter(Boolean) : [],
  };
}

// `git status --porcelain -z` 的 rename／copy 紀錄是 `R  <新路徑>\0<舊路徑>\0`，佔兩個欄位。
// 只取新路徑：rename 只會在索引裡被偵測到，舊路徑的刪除早已在索引中，再 git add 一次反而會
// 因為「pathspec 不符任何檔案」而失敗。未用 git mv 的改名會拆成 `D 舊` 與 `?? 新` 兩筆，照常處理。
function changedPaths(git, cwd) {
  const raw = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']).stdout.split('\0');
  const paths = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return [...new Set(paths.filter(Boolean))];
}

// 用 pathspec 檔案而不是命令列參數：專案可能有上萬個檔案，Windows 的命令列長度會爆掉。
function addPaths(git, cwd, paths) {
  const listFile = join(tmpdir(), `taskflow-add-${process.pid}-${Date.now()}.paths`);
  try {
    writeFileSync(listFile, `${paths.join('\0')}\0`);
    git(cwd, ['add', '--pathspec-from-file', listFile, '--pathspec-file-nul']);
  } finally { rmSync(listFile, { force: true }); }
}

const stagedPaths = (git, cwd) => git(cwd, ['diff', '--cached', '--name-only', '-z'], { allowFailure: true }).stdout.split('\0').filter(Boolean);
const unsafePaths = paths => paths.filter(path => path.split('/').some(isUnsafeToCommit));

function commitArgs(git, repositoryPath) {
  const email = git(repositoryPath, ['config', 'user.email'], { allowFailure: true });
  const name = git(repositoryPath, ['config', 'user.name'], { allowFailure: true });
  const identity = [];
  if (!firstLine(email.stdout)) identity.push('-c', 'user.email=taskflow@localhost');
  if (!firstLine(name.stdout)) identity.push('-c', 'user.name=TaskFlow');
  return identity;
}

function ensureGitignore(projectPath, entries) {
  const path = join(projectPath, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set(existing.split('\n').map(line => line.trim()));
  const missing = entries.filter(entry => !present.has(entry));
  if (!missing.length) return { created: false, added: [] };
  const body = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeFileSync(path, `${body}${body ? '\n' : ''}${IGNORE_HEADER}\n${missing.join('\n')}\n`);
  return { created: !existing, added: missing };
}

// 既有專案永遠不會走到這裡（inspectRepository 先擋掉），所以不可能重複 git init。
export function initRepository(projectPath, { git, defaultBranch = 'main', ignoreEntries = DEFAULT_IGNORE_ENTRIES }) {
  const events = [];
  git(projectPath, ['init']);
  git(projectPath, ['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
  const ignore = ensureGitignore(projectPath, ignoreEntries);
  if (ignore.added.length) events.push({ kind: 'git_init', message: `已${ignore.created ? '建立' : '補上'} .gitignore 規則：${ignore.added.join('、')}` });

  // 逐一列出未被 .gitignore 排除的檔案，再剔除疑似機密／執行期資料的路徑，
  // 只把剩下的檔案加入索引——所以初始 commit 的內容是列舉出來的，不是 `git add .` 的結果。
  const entries = changedPaths(git, projectPath);
  const skipped = unsafePaths(entries);
  const candidates = entries.filter(path => !skipped.includes(path));
  if (candidates.length) addPaths(git, projectPath, candidates);

  // 第二層防線：即使上面有遺漏，帶有機密特徵的路徑也不會留在索引裡。
  const staged = stagedPaths(git, projectPath);
  const unsafe = unsafePaths(staged);
  if (unsafe.length) git(projectPath, ['rm', '--cached', '--quiet', '--', ...unsafe]);

  const identity = commitArgs(git, projectPath);
  const remaining = staged.length - unsafe.length;
  const skippedTop = [...new Set(skipped.map(path => path.split('/')[0]))];
  git(projectPath, [...identity, 'commit', ...(remaining ? [] : ['--allow-empty']), '-m', 'chore: initialize project']);
  const head = firstLine((git(projectPath, ['rev-parse', 'HEAD'])).stdout);
  events.unshift({ kind: 'git_init', message: `專案不是 Git repository，已建立 Git 版本庫與 ${defaultBranch} 分支，初始 commit 收錄 ${remaining} 個檔案。` });
  if (skippedTop.length || unsafe.length) {
    events.push({ kind: 'git_init', message: `初始 commit 已略過可能含機密或執行期資料的項目：${[...new Set([...skippedTop, ...unsafe])].slice(0, 20).join('、')}` });
  }
  return { defaultBranch, head, events };
}

function worktreePaths(git, repositoryPath) {
  const list = git(repositoryPath, ['worktree', 'list', '--porcelain'], { allowFailure: true });
  return list.ok ? list.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length).trim())) : [];
}

// 每個任務一個 worktree：共用 .git 歷史、工作樹獨立，所以並行任務不會互相切換分支，
// 使用者的專案目錄也始終停在他自己的分支上。
export function prepareTaskWorkspace({
  projectPath, taskId, title = '', worktreesDir,
  protectedBranches = DEFAULT_PROTECTED_BRANCHES, defaultBranch = 'main', git,
}) {
  const events = [];
  let state = inspectRepository(projectPath, { git });

  if (!state.isRepository) {
    const init = initRepository(projectPath, { git, defaultBranch });
    events.push(...init.events);
    state = inspectRepository(projectPath, { git });
  } else if (state.nested) {
    throw new GitSafetyError('nested_repository',
      `此專案位於另一個 Git repository 之內（版本庫根目錄：${state.repositoryPath}）。TaskFlow 不會替你在上層版本庫建立分支或修改其內容，請改為指定版本庫根目錄作為專案，或先在此資料夾獨立建立版本庫。`,
      { repositoryPath: state.repositoryPath });
  }

  const { repositoryPath } = state;
  if (!state.head) {
    throw new GitSafetyError('no_commits',
      '此 Git repository 還沒有任何 commit，無法建立任務分支。請先自行完成第一次 commit 再開始任務。');
  }
  if (!state.branch) {
    throw new GitSafetyError('detached_head',
      '目前專案處於 detached HEAD 狀態，TaskFlow 無法判斷要從哪個分支開始。請先切換到正式分支再開始任務。');
  }

  const workingDirectory = resolve(join(worktreesDir, taskId));
  const registered = worktreePaths(git, repositoryPath);
  const reusing = registered.some(path => samePath(path, workingDirectory));

  if (!reusing && state.dirty.length) {
    throw new GitSafetyError('dirty_working_tree',
      `目前專案存在未提交修改。\n\nTaskFlow 不會自動修改或清除這些內容。\n\n請先確認後再開始任務。\n\n${state.dirty.slice(0, 30).join('\n')}`,
      { files: state.dirty.slice(0, 30) });
  }

  const workingBranch = taskBranchName({ taskId, title });
  if (isProtectedBranch(workingBranch, protectedBranches)) {
    throw new GitSafetyError('protected_branch', `任務分支名稱 ${workingBranch} 與受保護分支重複，已停止。`, { branch: workingBranch });
  }

  if (!reusing) {
    const branchExists = (git(repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${workingBranch}`], { allowFailure: true })).ok;
    mkdirSync(worktreesDir, { recursive: true });
    if (existsSync(workingDirectory) && readdirSync(workingDirectory).length) {
      throw new GitSafetyError('worktree_path_taken', `工作目錄 ${workingDirectory} 已存在且不是本任務的 git worktree，已停止以免覆蓋內容。`, {});
    }
    git(repositoryPath, branchExists
      ? ['worktree', 'add', workingDirectory, workingBranch]
      : ['worktree', 'add', workingDirectory, '-b', workingBranch, state.branch]);
    events.push({ kind: 'git_branch', message: `已從 ${state.branch} 建立任務分支 ${workingBranch}，並在獨立的 git worktree 中執行，不會修改專案原目錄。` });
  } else {
    events.push({ kind: 'git_branch', message: `沿用既有任務分支 ${workingBranch} 的 git worktree。` });
  }

  const headCommit = firstLine((git(workingDirectory, ['rev-parse', 'HEAD'])).stdout);
  return {
    git: {
      mode: 'worktree',
      repositoryPath,
      workingDirectory,
      baseBranch: state.branch,
      workingBranch,
      baseCommit: state.head,
      headCommit,
    },
    events,
  };
}

// 每次派工前都重跑的 deterministic guard：工作目錄必須還在這個任務自己的分支上，
// 而且永遠不可能是 main／master 等受保護分支。任何不符就直接停止，不執行 Agent。
export function assertWorkingBranch({ workingDirectory, workingBranch, protectedBranches = DEFAULT_PROTECTED_BRANCHES, git }) {
  if (!existsSync(workingDirectory)) {
    throw new GitSafetyError('worktree_missing', `任務的 git worktree 已不存在：${workingDirectory}。請確認是否被手動移除。`, {});
  }
  const current = firstLine((git(workingDirectory, ['branch', '--show-current'], { allowFailure: true })).stdout);
  if (!current) {
    throw new GitSafetyError('detached_head', 'Git safety check failed.\n\n任務工作目錄目前不在任何分支上（detached HEAD），TaskFlow 不允許在此狀態執行 Agent。');
  }
  if (isProtectedBranch(current, protectedBranches)) {
    throw new GitSafetyError('protected_branch', `Git safety check failed.\n\n目前位於 ${current}，TaskFlow Agent 不允許直接修改正式 branch。`, { branch: current });
  }
  if (workingBranch && current !== workingBranch) {
    throw new GitSafetyError('branch_changed', `Git safety check failed.\n\n任務分支應為 ${workingBranch}，但工作目錄目前在 ${current}。TaskFlow 不會自動切換分支，請先確認。`, { branch: current, expected: workingBranch });
  }
  return current;
}

// Phase 2：一個階段結束後保存開發成果。
//
// 兩個原則：
//   1. 「有修改才 commit」，不是「每個 step 一定 commit」——沒有檔案變動就不留空 commit。
//   2. commit 只代表「這段工作被保存下來」，不代表驗收通過。是否通過寫在 commit 訊息裡，
//      由 TaskFlow 的任務狀態決定能不能合併；commit 本身永遠不是核准。
// 每次 commit 前都重跑分支守門：工作目錄若已不在該任務分支上，寧可不 commit 也不寫錯地方。
export function commitWorkspaceChanges({
  workingDirectory, workingBranch, subject, body = '',
  protectedBranches = DEFAULT_PROTECTED_BRANCHES, git,
}) {
  assertWorkingBranch({ workingDirectory, workingBranch, protectedBranches, git });

  const entries = changedPaths(git, workingDirectory);
  if (!entries.length) return { committed: false, reason: 'no_changes', files: [], skipped: [] };

  const skipped = unsafePaths(entries);
  const candidates = entries.filter(path => !skipped.includes(path));
  if (!candidates.length) return { committed: false, reason: 'only_excluded_changes', files: [], skipped };

  addPaths(git, workingDirectory, candidates);
  const staged = stagedPaths(git, workingDirectory);
  const unsafe = unsafePaths(staged);
  if (unsafe.length) git(workingDirectory, ['rm', '--cached', '--quiet', '--', ...unsafe]);

  const files = staged.filter(path => !unsafe.includes(path));
  if (!files.length) return { committed: false, reason: 'only_excluded_changes', files: [], skipped: [...new Set([...skipped, ...unsafe])] };

  const message = body ? `${subject}\n\n${body}` : subject;
  git(workingDirectory, [...commitArgs(git, workingDirectory), 'commit', '-m', message]);
  return {
    committed: true,
    commit: firstLine(git(workingDirectory, ['rev-parse', 'HEAD']).stdout),
    subject, files, skipped: [...new Set([...skipped, ...unsafe])],
  };
}

export function readHead({ workingDirectory, git }) {
  const head = git(workingDirectory, ['rev-parse', 'HEAD'], { allowFailure: true });
  return head.ok ? firstLine(head.stdout) : null;
}

// 一個任務分支上，從 base 之後由 TaskFlow 產生的 commit。Phase 3 的 Review 會用到。
export function taskCommits({ workingDirectory, baseCommit, git, limit = 100 }) {
  const log = git(workingDirectory, ['log', '--format=%H%x1f%s%x1f%aI', `${baseCommit}..HEAD`], { allowFailure: true });
  if (!log.ok) return [];
  return log.stdout.split('\n').map(line => line.trim()).filter(Boolean).slice(0, limit)
    .map(line => { const [commit, subject, at] = line.split('\x1f'); return { commit, subject, at }; });
}

// Phase 3：人工核准後的合併、清理與 rollback。
//
// 這裡的每一個動作都只在使用者按下按鈕後才會發生，而且都先檢查「正式分支現在乾不乾淨」。
// 衝突一律先預檢：TaskFlow 不會替你選 ours／theirs，也不會把你的正式分支丟在一個
// 解到一半的 merge 狀態裡。
const CONFLICT_HINT = 'TaskFlow 不會自行決定 ours／theirs。請在專案目錄手動處理衝突後再回來，或改為要求 AI 修改。';

function assertMergeReady({ repositoryPath, baseBranch, git }) {
  const state = inspectRepository(repositoryPath, { git });
  if (!state.isRepository) throw new GitSafetyError('not_a_repository', '專案已不是 Git repository，無法合併。');
  if (state.branch !== baseBranch) {
    throw new GitSafetyError('base_branch_not_checked_out',
      `合併前專案目錄必須停在 ${baseBranch}，但目前在 ${state.branch || 'detached HEAD'}。TaskFlow 不會替你切換分支，請先自行切換後再核准合併。`,
      { branch: state.branch, baseBranch });
  }
  if (state.dirty.length) {
    throw new GitSafetyError('dirty_working_tree',
      `${baseBranch} 目前存在未提交修改，已停止合併。\n\nTaskFlow 不會自動修改或清除這些內容。\n\n${state.dirty.slice(0, 30).join('\n')}`,
      { files: state.dirty.slice(0, 30) });
  }
  return state;
}

// 先算出合併結果但不碰工作樹。git 2.38 以上用 merge-tree --write-tree；更舊的版本退回
// 「真的試一次、衝突就 abort」，abort 需要走明確授權通道。
function detectMergeConflicts({ repositoryPath, baseBranch, workingBranch, git }) {
  const probe = git(repositoryPath, ['merge-tree', '--write-tree', '--name-only', baseBranch, workingBranch], { allowFailure: true });
  const lines = probe.stdout.split('\n');
  if (/^[0-9a-f]{40,64}$/.test(firstLine(probe.stdout))) {
    if (probe.ok) return { conflicted: false, files: [] };
    const files = [];
    for (const line of lines.slice(1)) { if (!line.trim()) break; files.push(line.trim()); }
    return { conflicted: true, files };
  }
  // 舊版 git：沒有 merge-tree --write-tree，只能實際試一次。
  const attempt = git(repositoryPath, ['merge', '--no-commit', '--no-ff', workingBranch], { allowFailure: true });
  if (attempt.ok) {
    git(repositoryPath, ['merge', '--abort'], { allowFailure: true, authorizedAs: 'abort_merge' });
    return { conflicted: false, files: [] };
  }
  const files = git(repositoryPath, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
    .stdout.split('\n').map(line => line.trim()).filter(Boolean);
  git(repositoryPath, ['merge', '--abort'], { allowFailure: true, authorizedAs: 'abort_merge' });
  return { conflicted: true, files };
}

export function mergeTaskBranch({ repositoryPath, baseBranch, workingBranch, subject, body = '', git }) {
  assertMergeReady({ repositoryPath, baseBranch, git });
  if (!git(repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${workingBranch}`], { allowFailure: true }).ok) {
    throw new GitSafetyError('branch_missing', `任務分支 ${workingBranch} 已不存在，無法合併。`, { branch: workingBranch });
  }
  if (git(repositoryPath, ['merge-base', '--is-ancestor', workingBranch, 'HEAD'], { allowFailure: true }).ok) {
    return { merged: false, reason: 'already_merged', baseBranch, workingBranch };
  }

  const conflicts = detectMergeConflicts({ repositoryPath, baseBranch, workingBranch, git });
  if (conflicts.conflicted) {
    return { merged: false, reason: 'conflict', files: conflicts.files, hint: CONFLICT_HINT, baseBranch, workingBranch };
  }

  const message = body ? `${subject}\n\n${body}` : subject;
  git(repositoryPath, [...commitArgs(git, repositoryPath), 'merge', '--no-ff', '--no-edit', '-m', message, workingBranch]);

  // 合併後再確認一次：工作樹必須是乾淨的，HEAD 必須真的包含任務分支。
  const after = inspectRepository(repositoryPath, { git });
  const contains = git(repositoryPath, ['merge-base', '--is-ancestor', workingBranch, 'HEAD'], { allowFailure: true }).ok;
  if (after.dirty.length || !contains) {
    throw new GitSafetyError('merge_incomplete',
      '合併後的狀態不如預期（工作樹不乾淨或 HEAD 未包含任務分支），已停止並保留現況等待人工確認。',
      { files: after.dirty.slice(0, 30) });
  }
  return { merged: true, commit: after.head, baseBranch, workingBranch, subject };
}

// 合併成功或使用者明確選擇刪除時才呼叫。worktree 內若還有未提交內容，git 會拒絕移除，
// 我們就照實回報而不是加 --force——那等於替使用者丟掉東西。
export function cleanupTaskBranch({ repositoryPath, workingDirectory, workingBranch, deleteUnmerged = false, git }) {
  const notes = [];
  if (workingDirectory && existsSync(workingDirectory) && worktreePaths(git, repositoryPath).some(path => samePath(path, workingDirectory))) {
    // 未提交的內容分兩種：AI／使用者真正的工作，和 TaskFlow 自己寫進去的暫存檔（.taskflow 等，
    // 它們本來就被排除在 commit 之外）。前者一律不動並照實回報；只有剩下後者時才移除目錄，
    // 否則每個任務都會因為自己的暫存檔而永遠清不掉。
    const leftovers = changedPaths(git, workingDirectory);
    const meaningful = leftovers.filter(path => !path.split('/').some(isUnsafeToCommit));
    if (meaningful.length) {
      return { removed: false, branchDeleted: false, reason: 'worktree_not_removable', files: meaningful.slice(0, 30),
        message: `工作目錄仍有未提交的內容，已保留不動：${meaningful.slice(0, 10).join('、')}` };
    }
    let removed = git(repositoryPath, ['worktree', 'remove', workingDirectory], { allowFailure: true });
    if (!removed.ok && leftovers.length) removed = git(repositoryPath, ['worktree', 'remove', '--force', workingDirectory], { allowFailure: true, authorizedAs: 'remove_internal_only_worktree' });
    if (!removed.ok) {
      return { removed: false, branchDeleted: false, reason: 'worktree_not_removable', message: `無法移除工作目錄，已保留不動：${(removed.stderr || '').trim().slice(0, 300)}` };
    }
    notes.push('已移除任務的 git worktree。');
  }
  git(repositoryPath, ['worktree', 'prune'], { allowFailure: true });

  const deleted = deleteUnmerged
    ? git(repositoryPath, ['branch', '-D', workingBranch], { allowFailure: true, authorizedAs: 'delete_rejected_branch' })
    : git(repositoryPath, ['branch', '-d', workingBranch], { allowFailure: true });
  if (!deleted.ok) {
    return { removed: true, branchDeleted: false, reason: 'branch_not_deleted', notes, message: `工作目錄已移除，但分支 ${workingBranch} 未刪除（可能尚未合併）：${(deleted.stderr || '').trim().slice(0, 300)}` };
  }
  notes.push(`已刪除任務分支 ${workingBranch}。`);
  return { removed: true, branchDeleted: true, notes };
}

// Rollback 不是「回去找舊的 vX 資料夾」，而是在正式分支上補一個反向 commit，歷史完整保留。
export function revertMergeCommit({ repositoryPath, baseBranch, mergeCommit, subject, git }) {
  assertMergeReady({ repositoryPath, baseBranch, git });
  const isMerge = (git(repositoryPath, ['rev-list', '--no-walk', '--count', '--merges', mergeCommit], { allowFailure: true }).stdout || '').trim() === '1';
  const args = [...commitArgs(git, repositoryPath), 'revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), mergeCommit];
  const reverted = git(repositoryPath, args, { allowFailure: true });
  if (!reverted.ok) {
    git(repositoryPath, ['revert', '--abort'], { allowFailure: true });
    throw new GitSafetyError('revert_failed',
      `撤銷 ${mergeCommit.slice(0, 8)} 時發生衝突或錯誤，已還原為撤銷前的狀態。${CONFLICT_HINT}\n${(reverted.stderr || '').trim().slice(0, 300)}`,
      { mergeCommit });
  }
  const head = firstLine(git(repositoryPath, ['rev-parse', 'HEAD']).stdout);
  if (subject) git(repositoryPath, [...commitArgs(git, repositoryPath), 'commit', '--amend', '--no-edit', '-m', subject], { allowFailure: true });
  return { reverted: true, commit: firstLine(git(repositoryPath, ['rev-parse', 'HEAD']).stdout) || head, mergeCommit };
}

export function createGitWorkspace({ git = createGitRunner() } = {}) {
  return {
    git,
    available: cwd => gitAvailable(git, cwd),
    inspect: (projectPath) => inspectRepository(projectPath, { git }),
    prepare: (options) => prepareTaskWorkspace({ ...options, git }),
    assertWorkingBranch: (options) => assertWorkingBranch({ ...options, git }),
    commit: (options) => commitWorkspaceChanges({ ...options, git }),
    head: (options) => readHead({ ...options, git }),
    commits: (options) => taskCommits({ ...options, git }),
    merge: (options) => mergeTaskBranch({ ...options, git }),
    cleanup: (options) => cleanupTaskBranch({ ...options, git }),
    revert: (options) => revertMergeCommit({ ...options, git }),
  };
}
