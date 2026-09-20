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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { detectRepositoryInfo, evaluateRepositoryPolicy, samePath } from './git-repository.js';
export { detectRepositoryInfo, evaluateRepositoryPolicy, REPOSITORY_TYPES } from './git-repository.js';

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
  // 使用者在網頁上明確按下「推送」時才會用到。形狀鎖死成 `push <remote> <branch>`：
  // 不接受任何旗標（--force、--mirror、--delete、--tags 都進不來），也不接受
  // `src:dst` 這種 refspec，所以這個通道推不出「把別的東西覆蓋掉」的指令。
  push_base_branch: args =>
    args.length === 3 && args[0] === 'push' &&
    args.slice(1).every(value => /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value) && !value.includes(':') && !value.includes('..')),
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

// 未提交修改的「快照指紋」：使用者確認過的那一組修改，之後每一輪都要能重新認出來，
// 否則同一組修改會被反覆詢問（見 git-issue.js 的 approval 流程）。
//
// 三個刻意的選擇：
//   1. 指紋取自 `git status --porcelain` 的**完整**輸出，不是顯示用的前 30 筆；否則
//      第 31 個檔案改動不會改變指紋，等於偷偷放行沒被確認過的修改。
//   2. untracked（`??`）與 staged／unstaged 一視同仁納入計算，新增檔案一定會改變指紋。
//   3. 排序後再 hash，git 輸出順序變動不會被誤判成「有新修改」。
export function dirtyFingerprint(dirty) {
  const normalized = [...(dirty || [])].map(line => String(line).replace(/\s+/g, ' ').trim()).filter(Boolean).sort().join('\n');
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

// 唯一的 repository 檢查入口。topology 由 git-repository.js 判斷（detection），
// 該不該停下來由 policy 決定；這裡只負責把兩者接上 Git 狀態（branch／HEAD／未提交修改）。
//
// 回傳值保留既有欄位（isRepository／repositoryPath／nested／branch／head／dirty），
// 讓 runner、git-issue、git-review、completion 等既有呼叫端不必同步改寫；
// 新的 canonical model 放在 `repository` 與 `policy` 兩個欄位裡。
export function inspectRepository(
  projectPath,
  { git, projectRoot = null, managedProjectsRoot = null }
) {
  if (!existsSync(projectPath)) {
    throw new GitSafetyError(
      'project_missing',
      `專案資料夾不存在：${projectPath}`
    );
  }

  const repository = detectRepositoryInfo(projectPath, {
    git,
    projectRoot,
    managedProjectsRoot,
  });

  const policy = evaluateRepositoryPolicy(repository);

  // managed-uninitialized 與 non-git 都還不是 repository：
  // 對外一律回報 isRepository: false，
  // 由 policy.nextAction = 'git-init' 決定接下來要初始化，
  // 而不是進入人工處理狀態。
  if (!repository.isGit) {
    return {
      isRepository: false,
      repositoryPath: null,
      nested: false,
      repository,
      policy,
    };
  }

  const repositoryPath = repository.worktreeRoot;

  const branchResult = git(
    repositoryPath,
    ['branch', '--show-current'],
    { allowFailure: true }
  );

  const headResult = git(
    repositoryPath,
    ['rev-parse', 'HEAD'],
    { allowFailure: true }
  );

  const statusResult = git(
    repositoryPath,
    ['status', '--porcelain'],
    { allowFailure: true }
  );

  // `git status` 自己失敗時絕對不能回報 dirty: []：
  // 那會讓「讀不到狀態」被當成「工作目錄乾淨」，
  // 於是守門形同關閉。
  if (!statusResult.ok) {
    throw new GitSafetyError(
      'git_status_failed',
      `無法讀取專案的 Git 狀態（git status 執行失敗），為安全起見已停止，不會假設工作目錄是乾淨的。\n\n${(
        statusResult.stderr ||
        statusResult.error?.message ||
        ''
      )
        .trim()
        .slice(0, 300)}`,
      { repositoryPath }
    );
  }

  const dirty = statusResult.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return {
    isRepository: true,
    repositoryPath,

    // `nested` 的語意是「這個路徑只是別人 repository 的子目錄」。
    // linked worktree 與 nested independent repository 都是合法 root，
    // 不會落在這裡。
    nested: repository.isSubdirectory,

    branch: branchResult.ok
      ? firstLine(branchResult.stdout) || null
      : null,

    head: headResult.ok
      ? firstLine(headResult.stdout) || null
      : null,

    dirty,
    dirtyFingerprint: dirtyFingerprint(dirty),
    repository,
    policy,
  };
}


// 可重用的 Git repository state inspector：
// 專供 merge 流程判斷「是否真的乾淨、真的合併完成」。
export function inspectMergeState({ repositoryPath, git }) {
  const state = inspectRepository(repositoryPath, { git });

  if (!state.isRepository) {
    throw new GitSafetyError(
      'not_a_repository',
      '專案已不是 Git repository，無法檢查合併狀態。',
      { repositoryPath }
    );
  }

  const unresolvedFiles = git(
    repositoryPath,
    ['diff', '--name-only', '--diff-filter=U'],
    { allowFailure: true }
  )
    .stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const mergeInProgress = git(
    repositoryPath,
    ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
    { allowFailure: true }
  ).ok;

  return {
    branch: state.branch,
    head: state.head,
    mergeInProgress,
    unresolvedFiles,
    dirty: state.dirty,
    clean:
      !state.dirty.length &&
      !mergeInProgress &&
      !unresolvedFiles.length,
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

// 供 Output Recovery 使用：讀取工作目錄「目前」尚未提交的真實變更檔案清單，作為
// 還原 artifacts 欄位時可信的 Git 證據來源，而不是重新推導一套判斷邏輯。
// 必須排除 isUnsafeToCommit 的路徑（例如 .taskflow/handoff.json）：那是 TaskFlow 自己
// 寫進工作目錄的交接紀錄，不是 AI／使用者的工作成果，否則每一次 Git 證據還原都會混入
// 這個檔案，見 commitWorkspaceChanges／cleanupTaskBranch 的同一原則。
export function currentChangedFiles({ workingDirectory, git }) {
  return changedPaths(git, workingDirectory).filter(path => !path.split('/').some(isUnsafeToCommit));
}

// `git diff --name-status -z` 的 rename／copy 紀錄是 `R100\0舊路徑\0新路徑\0`，其餘狀態是
// `<status>\0路徑\0`。這裡把它轉成給「成果」分頁用的結構化清單，狀態轉成中性英文字，
// 不依賴呼叫端認得 git 的單字母代碼。
function parseDiffNameStatus(raw) {
  const tokens = String(raw || '').split('\0');
  const statusName = { A: 'added', M: 'modified', D: 'deleted', T: 'modified' };
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[++i];
      const path = tokens[++i];
      if (path) files.push({ path, oldPath, status: status[0] === 'R' ? 'renamed' : 'copied' });
    } else {
      const path = tokens[++i];
      if (path) files.push({ path, status: statusName[status[0]] || 'modified' });
    }
  }
  return files;
}

// 「成果」分頁的 diff 清單：基準固定是 task.git.baseCommit，範圍涵蓋「baseCommit 到目前
// 工作副本」——也就是已經 commit 的階段成果，加上使用者這一刻還沒 commit 的變更，兩者
// 合在一起才是使用者現在看到的完整差異，不是只比對 index／HEAD。
//
// `git diff <baseCommit>`（不帶第二個 ref）本身就是拿 baseCommit 與目前工作樹比較，天然
// 涵蓋尚未 commit 的部分；缺的只有完全沒進過 index 的 untracked 新檔案，另外用
// `git status` 補上。非 Git 模式（baseCommit 為空）不是錯誤，只是沒有 diff 可看。
export function taskDiffFiles({ workingDirectory, baseCommit, git }) {
  if (!baseCommit) {
    return { available: false, reason: 'not_git', message: '此任務非 Git 模式，無法顯示差異。', files: [] };
  }

  const tracked = git(workingDirectory, ['diff', '--name-status', '-M', '-z', baseCommit], { allowFailure: true });
  if (!tracked.ok) {
    throw new GitSafetyError('git_command_failed', `無法計算與 ${baseCommit.slice(0, 8)} 的差異：${(tracked.stderr || '').trim().slice(0, 300)}`, { baseCommit });
  }
  const trackedFiles = parseDiffNameStatus(tracked.stdout);

  const statusRaw = git(workingDirectory, ['status', '--porcelain', '-z', '--untracked-files=all'], { allowFailure: true });
  const untrackedFiles = [];
  if (statusRaw.ok) {
    const raw = statusRaw.stdout.split('\0');
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      if (!entry) continue;
      if (entry.slice(0, 2) === '??') untrackedFiles.push({ path: entry.slice(3), status: 'added' });
      else if (entry[0] === 'R' || entry[0] === 'C') i++; // 已由 tracked diff 涵蓋，這裡只跳過舊路徑欄位
    }
  }

  const seen = new Set();
  const files = [];
  for (const file of [...trackedFiles, ...untrackedFiles]) {
    const unsafe = file.path.split('/').some(isUnsafeToCommit) || (file.oldPath && file.oldPath.split('/').some(isUnsafeToCommit));
    if (unsafe || seen.has(file.path)) continue;
    seen.add(file.path);
    files.push(file);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { available: true, files };
}

// 單一檔案的 diff 內容，基準與 taskDiffFiles 一致（baseCommit → 目前工作副本，含未 commit
// 變更）。已追蹤檔案（含刪除、修改、重新命名）直接用 `git diff <baseCommit> -- <path>`，
// 一個指令天然涵蓋「已 commit ＋尚未 commit」；untracked 新檔案不在任何 commit 或 index 裡，
// `git diff <baseCommit>` 看不到它，改用 `git diff --no-index -- /dev/null <path>` 合成一份
// 「整檔新增」的 diff——沿用 git 自己的二進位偵測與行尾處理，不必自己重寫一套。
//
// 路徑安全性（拒絕逃出 workspace、.git/.env/金鑰等）由呼叫端（HTTP 路由）比照 /download
// 既有規則檢查；這裡另外用 isUnsafeToCommit 擋一層，避免有其他呼叫路徑漏掉檢查。
export function taskFileDiff({ workingDirectory, baseCommit, path, oldPath = null, git }) {
  if (!baseCommit) {
    return { available: false, reason: 'not_git', message: '此任務非 Git 模式，無法顯示差異。', diff: '' };
  }
  for (const segment of [path, oldPath].filter(Boolean)) {
    if (String(segment).split('/').some(isUnsafeToCommit)) {
      throw new GitSafetyError('unsafe_path', `不允許存取此路徑：${segment}`, { path: segment });
    }
  }

  const statusCheck = git(workingDirectory, ['status', '--porcelain', '-z', '--untracked-files=all', '--', path], { allowFailure: true });
  const isUntracked = statusCheck.ok && statusCheck.stdout.split('\0').some(entry => entry.slice(0, 2) === '??');

  if (isUntracked) {
    const untracked = git(workingDirectory, ['diff', '--no-index', '--', '/dev/null', path], { allowFailure: true });
    return { available: true, status: 'added', diff: untracked.stdout || '' };
  }

  const args = ['diff', '-M', baseCommit, '--'];
  if (oldPath && oldPath !== path) args.push(oldPath);
  args.push(path);
  const result = git(workingDirectory, args, { allowFailure: true });
  if (!result.ok) {
    throw new GitSafetyError('git_command_failed', `無法取得 ${path} 的差異內容：${(result.stderr || '').trim().slice(0, 300)}`, { path });
  }
  return { available: true, status: null, diff: result.stdout || '' };
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

// 專案建立時就給它自己的 repository boundary，而不是等到第一個任務才補。
//
// 為什麼要在建立時做：TaskFlow 在「預設專案存放位置」底下建立的新專案，如果那個位置本身
// 位於另一個 repository 裡（例如 F:\TaskFlow\Projects\），在還沒 git init 前會被 Git 解析成
// 上層 repository 的一部分。先初始化，之後的每一次 detection 都會直接得到 normal／
// nested-independent，不必再走 managed-uninitialized 這條補救路徑。
//
// 這個函式只在 policy 說「可以自己初始化」時才動手：真正屬於別人 repository 的子目錄
// （nextAction = 'user-action'）一律不碰，避免在別人追蹤中的工作樹裡塞一個內嵌版本庫。
// 失敗不是致命的——回報原因即可，第一個任務開始時 prepareTaskWorkspace 會再試一次。
export function ensureProjectRepository(projectPath, { git, projectRoot = null, managedProjectsRoot = null, defaultBranch = 'main' }) {
  if (!existsSync(projectPath)) return { initialized: false, reason: 'project_missing', events: [] };
  if (!gitAvailable(git, projectPath)) return { initialized: false, reason: 'git_unavailable', events: [] };
  const repository = detectRepositoryInfo(projectPath, { git, projectRoot, managedProjectsRoot });
  const policy = evaluateRepositoryPolicy(repository);
  if (policy.nextAction !== 'git-init') return { initialized: false, reason: repository.repositoryType, repository, policy, events: [] };
  try {
    const init = initRepository(projectPath, { git, defaultBranch });
    return { initialized: true, reason: null, repository, policy, defaultBranch: init.defaultBranch, head: init.head, events: init.events };
  } catch (e) {
    return { initialized: false, reason: 'init_failed', error: e.message, repository, policy, events: [] };
  }
}

function worktreePaths(git, repositoryPath) {
  const list = git(repositoryPath, ['worktree', 'list', '--porcelain'], { allowFailure: true });
  return list.ok ? list.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length).trim())) : [];
}

// 每個任務一個 worktree：共用 .git 歷史、工作樹獨立，所以並行任務不會互相切換分支，
// 使用者的專案目錄也始終停在他自己的分支上。
export function prepareTaskWorkspace({
  projectPath, taskId, title = '', worktreesDir,
  protectedBranches = DEFAULT_PROTECTED_BRANCHES, defaultBranch = 'main',
  approvedDirtyFingerprint = null, projectRoot = null, managedProjectsRoot = null, git,
}) {
  const events = [];
  const context = { git, projectRoot, managedProjectsRoot };
  let state = inspectRepository(projectPath, context);

  // 決策一律走 policy，不再自己判斷 `nested`。順序很重要：先擋掉必須由人處理的情況，
  // 再處理「TaskFlow 可以自己解決」的初始化，否則會在別人的 repository 裡 git init。
  if (state.policy.blocked) {
    throw new GitSafetyError('nested_repository',
      `此專案位於另一個 Git repository 之內（版本庫根目錄：${state.repositoryPath}）。TaskFlow 不會替你在上層版本庫建立分支或修改其內容，請改為指定版本庫根目錄作為專案，或先在此資料夾獨立建立版本庫。`,
      { repositoryPath: state.repositoryPath, repositoryType: state.repository.repositoryType, blockReason: state.policy.blockReason });
  }

  if (state.policy.nextAction === 'git-init') {
    // managed-uninitialized：專案實體上位於另一個 repository 底下，但它是 TaskFlow 自己管理的
    // 專案 root。把這件事寫進工作紀錄，使用者才知道為什麼這裡會多出一個版本庫。
    const outer = state.repository.inheritedOuterRepository;
    if (outer) {
      events.push({ kind: 'git_init', message: `此專案是 TaskFlow 管理的專案資料夾，但尚未有自己的 Git 版本庫，因此 Git 先前把它解析成上層版本庫（${outer}）的子目錄。TaskFlow 現在為它建立獨立的版本庫；上層版本庫的內容不會被修改。` });
    }
    const init = initRepository(projectPath, { git, defaultBranch });
    events.push(...init.events);
    state = inspectRepository(projectPath, context);
    if (!state.isRepository || state.policy.blocked) {
      throw new GitSafetyError('git_init_incomplete',
        `已嘗試為此專案建立獨立的 Git 版本庫，但重新檢查後仍不是一個可用的版本庫根目錄（目前判定：${state.repository.repositoryType}）。為安全起見已停止，不會在上層版本庫上進行任何操作。`,
        { repositoryPath: state.repositoryPath, repositoryType: state.repository.repositoryType });
    }
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

  // 未提交修改只有兩種出路：使用者自己處理掉，或使用者明確確認「保留這一組修改並繼續」。
  // 第二種情況會帶著 approvedDirtyFingerprint 進來；指紋一致代表現在看到的就是他確認過的
  // 那一組修改，可以繼續。指紋不同代表又有新的修改，必須重新確認，絕不自動放行。
  // 注意：確認的語意是「TaskFlow 不動這些檔案」，不是「把它們帶進任務」——任務分支照樣
  // 從最後一次 commit 開出，未提交修改留在使用者的專案目錄裡，原樣不動。
  if (!reusing && state.dirty.length) {
    if (approvedDirtyFingerprint && approvedDirtyFingerprint === state.dirtyFingerprint) {
      events.push({
        kind: 'git_dirty_approved',
        message: `已依你的確認保留專案目錄中的 ${state.dirty.length} 項未提交修改：不 reset、不 clean、不 stash、不刪除、不覆蓋。任務分支自最後一次 commit（${String(state.head).slice(0, 8)}）開出，這些未提交修改不會進入任務工作副本。`,
      });
    } else {
      throw new GitSafetyError('dirty_working_tree',
        `目前專案存在未提交修改。\n\nTaskFlow 不會自動修改或清除這些內容。\n\n請先確認後再開始任務。\n\n${state.dirty.slice(0, 30).join('\n')}`,
        { files: state.dirty.slice(0, 30), fileCount: state.dirty.length, fingerprint: state.dirtyFingerprint, branch: state.branch });
    }
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
//
// head 預設是 HEAD（worktree 還在時，那就是任務分支自己的最新 commit）；worktree 清理後
// 已經沒有「這個目錄的 HEAD」可讀，Ready to Close 畫面改傳 gitMerge.commit 進來，
// 在 repositoryPath 上讀 baseCommit..gitMerge.commit 這個固定範圍，仍能列出這條分支的 commit。
export function taskCommits({ workingDirectory, baseCommit, head = 'HEAD', git, limit = 100 }) {
  const log = git(workingDirectory, ['log', '--format=%H%x1f%s%x1f%aI', `${baseCommit}..${head}`], { allowFailure: true });
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
  // 「衝突已解決但尚未 commit」（MERGE_HEAD 仍在）與一般 dirty_working_tree 是完全不同的處境：
  // 前者不需要使用者再解一次衝突，只差一個 commit 或一次 abort，訊息必須分開辨識，
  // 不能被下面籠統的 dirty_working_tree 蓋過去。因此在 dirty 檢查之前先看 MERGE_HEAD。
  const merge = inspectMergeState({ repositoryPath, git });
  if (merge.mergeInProgress) {
    throw new GitSafetyError('merge_in_progress',
      `${baseBranch} 目前處於一個進行中的 merge（MERGE_HEAD 仍存在）。這通常代表衝突已經解決但尚未完成 commit。\n\n${merge.unresolvedFiles.length ? `仍未解決的檔案：\n${merge.unresolvedFiles.join('\n')}\n\n` : ''}請先在專案目錄完成這個 merge（commit）或執行 git merge --abort 中止它，再回來核准合併。`,
      { unresolvedFiles: merge.unresolvedFiles, branch: state.branch });
  }
  if (state.dirty.length) {
    throw new GitSafetyError('dirty_working_tree',
      `${baseBranch} 目前存在未提交修改，已停止合併。\n\nTaskFlow 不會自動修改或清除這些內容。\n\n${state.dirty.slice(0, 30).join('\n')}`,
      { files: state.dirty.slice(0, 30), fileCount: state.dirty.length, fingerprint: state.dirtyFingerprint, branch: state.branch });
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
  // 舊版 git（< 2.38）：沒有 merge-tree --write-tree，只能實際試一次。
  // 這裡必須帶上 commitArgs：即使是 --no-commit，git 也會先要求 committer identity，
  // 而 TaskFlow 明確支援「專案沒有設定 user.name／user.email」的情況。少了它，這一步會
  // 因為身分不明而失敗，被誤讀成「有衝突」——而且是一個沒有任何衝突檔案的假衝突。
  const attempt = git(repositoryPath, [...commitArgs(git, repositoryPath), 'merge', '--no-commit', '--no-ff', workingBranch], { allowFailure: true });
  if (attempt.ok) {
    git(repositoryPath, ['merge', '--abort'], { allowFailure: true, authorizedAs: 'abort_merge' });
    return { conflicted: false, files: [] };
  }
  const files = git(repositoryPath, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
    .stdout.split('\n').map(line => line.trim()).filter(Boolean);
  git(repositoryPath, ['merge', '--abort'], { allowFailure: true, authorizedAs: 'abort_merge' });
  // 真正的衝突一定至少有一個 unmerged path。一個檔案都沒有，代表這次 merge 根本沒開始
  // （身分不明、unrelated histories、權限…）。把它當成衝突會讓合併永遠被擋住，而且錯誤訊息
  // 指向錯的方向，所以照實往外拋，讓使用者看到 git 真正說了什麼。
  if (!files.length) {
    throw new GitSafetyError('merge_probe_failed',
      `無法試算合併結果（git merge 未能開始，且沒有任何衝突檔案），為安全起見已停止，正式分支未被改動。\n\n${(attempt.stderr || attempt.error?.message || '').trim().slice(0, 300)}`,
      { baseBranch, workingBranch });
  }
  return { conflicted: true, files };
}

// 唯讀預覽：只算「合併會不會衝突」，完全不碰工作樹、不建立 commit。
// Git Delivery 畫面每次開啟都要重新問一次「現在合不合併得起來」，不能沿用任務完成
// 當下或上一次合併時的舊結論（main 可能在這之間前進了）。
export function previewMerge({ repositoryPath, baseBranch, workingBranch, git }) {
  if (!git(repositoryPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${workingBranch}`], { allowFailure: true }).ok) {
    return { available: false, reason: 'branch_missing' };
  }
  if (git(repositoryPath, ['merge-base', '--is-ancestor', workingBranch, baseBranch], { allowFailure: true }).ok) {
    return { available: true, alreadyMerged: true, conflicted: false, files: [] };
  }
  const conflicts = detectMergeConflicts({ repositoryPath, baseBranch, workingBranch, git });
  return { available: true, alreadyMerged: false, conflicted: conflicts.conflicted, files: conflicts.files };
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
  // pre-check（merge-tree）通過後，實際執行仍可能失敗——兩者之間可能有新的變化，或舊版 git 的
  // 探測本身就不夠準。這裡不信任這個 command 的 exit code：allowFailure，執行完一律用
  // inspectMergeState 讀 Git 本身的真實狀態做最終判斷，成功與否由狀態決定，不是由 AI 或
  // command 回報的文字決定。
  git(repositoryPath, [...commitArgs(git, repositoryPath), 'merge', '--no-ff', '--no-edit', '-m', message, workingBranch], { allowFailure: true });

  const after = inspectMergeState({ repositoryPath, git });
  if (after.mergeInProgress || after.unresolvedFiles.length) {
    const files = after.unresolvedFiles.length ? after.unresolvedFiles : after.dirty;
    // 不管這次衝突是不是我們剛剛觸發的，都不留下解到一半的 merge：abort 讓 baseBranch 回到
    // 合併前的乾淨狀態，不需要使用者自己動手清理，也不會有殘留的 MERGE_HEAD。
    git(repositoryPath, ['merge', '--abort'], { allowFailure: true, authorizedAs: 'abort_merge' });
    return { merged: false, reason: 'conflict', files, hint: CONFLICT_HINT, baseBranch, workingBranch };
  }

  // 合併後再確認一次：工作樹必須是乾淨的，HEAD 必須真的包含任務分支。
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

// Phase 4：把本機正式分支推到遠端。
//
// 這是整條流程最後一個還會把人趕回終端機的步驟。它**不是**自動化的一環：
// 預設不推，必須由使用者在網頁上明確按下去（計畫書第十六章）。
//
// 四個不可妥協的原則：
//   1. 只推正式分支到指定 remote，形狀鎖死（見 AUTHORIZED_COMMANDS.push_base_branch）。
//   2. 落後遠端時一律拒絕。那代表遠端有你沒有的 commit，需要先合併或 rebase——
//      TaskFlow 不會替你決定怎麼整合別人的工作。
//   3. 工作樹不乾淨、或不在正式分支上，都不推。
//   4. 推完再確認一次真的推上去了（ahead 歸零），不是送出指令就宣稱成功。
export function remoteStatus({ repositoryPath, baseBranch, remote = 'origin', git, fetch = true }) {
  const url = git(repositoryPath, ['remote', 'get-url', remote], { allowFailure: true });
  if (!url.ok) return { configured: false, remote, reason: 'no_remote' };
  // fetch 是唯讀的：它只更新遠端追蹤分支，不會動到你的任何 commit 或工作樹。
  if (fetch) git(repositoryPath, ['fetch', '--quiet', remote, baseBranch], { allowFailure: true });

  const counts = git(repositoryPath, ['rev-list', '--left-right', '--count', `${remote}/${baseBranch}...${baseBranch}`], { allowFailure: true });
  if (!counts.ok) {
    return { configured: true, remote, url: firstLine(url.stdout), reason: 'no_upstream_branch', ahead: null, behind: null };
  }
  const [behind, ahead] = firstLine(counts.stdout).split(/\s+/).map(Number);
  return { configured: true, remote, url: firstLine(url.stdout), baseBranch, ahead, behind, reason: null };
}

export function pushBaseBranch({ repositoryPath, baseBranch, remote = 'origin', git }) {
  const state = assertMergeReady({ repositoryPath, baseBranch, git });
  const status = remoteStatus({ repositoryPath, baseBranch, remote, git });
  if (!status.configured) {
    throw new GitSafetyError('no_remote', `專案沒有設定名為 ${remote} 的遠端，無法推送。`, { remote });
  }
  if (status.behind > 0) {
    throw new GitSafetyError('behind_remote',
      `${remote}/${baseBranch} 有 ${status.behind} 個你本機還沒有的 commit。TaskFlow 不會替你決定要用 merge 還是 rebase 整合別人的工作，請先自行處理後再推送。`,
      { ahead: status.ahead, behind: status.behind });
  }
  if (status.ahead === 0) return { pushed: false, reason: 'up_to_date', remote, baseBranch };

  git(repositoryPath, ['push', remote, baseBranch], { authorizedAs: 'push_base_branch' });

  // 推完再問一次遠端：送出指令不等於推上去了。
  const after = remoteStatus({ repositoryPath, baseBranch, remote, git });
  if (after.ahead !== 0) {
    throw new GitSafetyError('push_incomplete',
      `推送後 ${remote}/${baseBranch} 仍落後 ${after.ahead} 個 commit，狀態不如預期，已停止並保留現況。`,
      { ahead: after.ahead });
  }
  return { pushed: true, remote, baseBranch, commit: state.head, count: status.ahead };
}

export function createGitWorkspace({ git = createGitRunner() } = {}) {
  return {
    git,
    available: cwd => gitAvailable(git, cwd),
    // context = { projectRoot, managedProjectsRoot }：讓 detection 認得出 TaskFlow 自己管理的
    // 專案 root。沒有帶 context 的呼叫端（Review／合併等，傳進來的已經是 repository root）
    // 行為與以前完全相同。
    inspect: (projectPath, context = {}) => inspectRepository(projectPath, { ...context, git }),
    detect: (projectPath, context = {}) => detectRepositoryInfo(projectPath, { ...context, git }),
    policy: (repositoryInfo) => evaluateRepositoryPolicy(repositoryInfo),
    ensureRepository: (projectPath, options = {}) => ensureProjectRepository(projectPath, { ...options, git }),
    prepare: (options) => prepareTaskWorkspace({ ...options, git }),
    assertWorkingBranch: (options) => assertWorkingBranch({ ...options, git }),
    commit: (options) => commitWorkspaceChanges({ ...options, git }),
    head: (options) => readHead({ ...options, git }),
    commits: (options) => taskCommits({ ...options, git }),
    merge: (options) => mergeTaskBranch({ ...options, git }),
    previewMerge: (options) => previewMerge({ ...options, git }),
    cleanup: (options) => cleanupTaskBranch({ ...options, git }),
    revert: (options) => revertMergeCommit({ ...options, git }),
    remoteStatus: (options) => remoteStatus({ ...options, git }),
    push: (options) => pushBaseBranch({ ...options, git }),
    currentChangedFiles: (options) => currentChangedFiles({ ...options, git }),
    diffFiles: (options) => taskDiffFiles({ ...options, git }),
    fileDiff: (options) => taskFileDiff({ ...options, git }),
  };
}
