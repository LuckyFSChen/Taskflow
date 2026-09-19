// Repository topology 的唯一判斷入口。
//
// 為什麼獨立成一個模組：TaskFlow 有好幾個地方需要知道「這個路徑到底是什麼」——runner 派工前、
// Git 問題重新檢查、專案建立、Review／合併。以前每個地方各自拼湊 `git rev-parse` 的結果，
// 於是同一個目錄在不同流程裡可能得到不同答案。這裡把它收斂成一份 canonical model：
//
//   detectRepositoryInfo()      只回答「現在的 Git / project topology 是什麼」，不做決策。
//   evaluateRepositoryPolicy()  只依據 topology 決定「該繼續、該初始化、還是該停下來問人」。
//
// 三個不可妥協的判斷原則：
//
//   1. Git 語意優先於 filesystem 結構。working tree root 以 `git rev-parse --show-toplevel`
//      為準，絕不用「向上找 .git」來決定 repository ownership——那會誤傷 linked worktree、
//      nested independent repository 與 submodule。父層 .git 掃描只保留為 diagnostic
//      （physicalParentRepository），不得覆蓋 Git 自己的回答。
//
//   2. `.git` 只判斷「存不存在」，不判斷是不是資料夾。linked worktree 的 .git 是一個文字檔
//      （內容是 `gitdir: ...`），用 isDirectory() 判斷會把合法的 worktree 判成非 repository。
//
//   3. 但 Git 語意不是唯一的事實來源。TaskFlow 自己在「預設專案存放位置」底下建立的專案
//      （例如 F:\TaskFlow\Projects\<新專案>）在還沒 git init 前，`--show-toplevel` 會一路
//      往上解析到 F:\TaskFlow。那個結果在純 Git 語意上正確，但在 TaskFlow 的產品語意上錯誤：
//      它是一個「尚未初始化 Git 的獨立專案 root」，不是 TaskFlow repository 的一般子目錄。
//      這種狀態叫 managed-uninitialized，出路是初始化它自己的 repository，不是叫使用者去處理。
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** @typedef {'normal'|'linked-worktree'|'managed-uninitialized'|'subdirectory'|'nested-independent'|'non-git'} RepositoryType */
export const REPOSITORY_TYPES = ['normal', 'linked-worktree', 'managed-uninitialized', 'subdirectory', 'nested-independent', 'non-git'];

// Windows 的 `F:\`、`F:/`、`F:\TaskFlow\` 與 `F:/TaskFlow` 必須視為同一路徑；但把磁碟根目錄
// 的分隔符號整個去掉會得到 `F:`（那是「目前目錄」而不是根目錄），所以只在不會退化時才去尾。
export function normalizePath(input) {
  const absolute = resolve(String(input ?? ''));
  const trimmed = absolute.replace(/[\\/]+$/, '');
  return trimmed && !trimmed.endsWith(':') ? trimmed : absolute;
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const [x, y] = [normalizePath(a), normalizePath(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** child 是否在 parent 底下（不含 parent 自己）。 */
export function isDescendant(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(normalizePath(parent), normalizePath(child));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

const firstLine = text => String(text || '').split('\n')[0].trim();

/** `git rev-parse --git-dir` 可能回傳相對路徑（`.git`、`../.git`），一律轉成絕對路徑再比較。 */
export function resolveGitPath(cwd, raw) {
  const value = firstLine(raw);
  return value ? normalizePath(isAbsolute(value) ? value : join(cwd, value)) : null;
}

// 只作為 diagnostic：告訴使用者「這個目錄實體上位於哪個 repository 底下」。
// 它永遠不參與 blocked 的判斷，也不得覆蓋 --show-toplevel 的結果（見檔頭原則 1）。
export function findPhysicalParentRepository(path) {
  let dir = dirname(normalizePath(path));
  for (let guard = 0; guard < 128; guard++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** `git worktree list --porcelain` → [{ path, branch, detached }]，第一筆是 main worktree。 */
export function parseWorktreeList(stdout) {
  const worktrees = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) worktrees.push({ path: normalizePath(line.slice('worktree '.length)), branch: null, detached: false });
    else if (line.startsWith('branch ') && worktrees.length) worktrees.at(-1).branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (line === 'detached' && worktrees.length) worktrees.at(-1).detached = true;
  }
  return worktrees;
}

/**
 * 目前路徑的 Git / project topology。純查詢，不做任何決策，也不執行任何會改變狀態的 git 指令。
 *
 * @param {string} projectPath 要判斷的路徑
 * @param {object} context
 * @param {(cwd:string,args:string[],opts?:object)=>{ok:boolean,stdout:string}} context.git
 * @param {string|null} [context.projectRoot] TaskFlow DB 記錄的這個專案的 root
 * @param {string|null} [context.managedProjectsRoot] 平台設定的「預設專案存放位置」
 * @returns {RepositoryInfo}
 */
export function detectRepositoryInfo(projectPath, { git, projectRoot = null, managedProjectsRoot = null } = {}) {
  const cwd = normalizePath(projectPath);

  // Managed project root 必須同時滿足兩個條件，缺一不可：
  //   a. 與 TaskFlow DB 記錄的 project root 完全一致（不是它的子目錄）
  //   b. 位於平台設定的「預設專案存放位置」底下（也就是 TaskFlow 自己建立與管理的那一批）
  // 第二個條件是刻意的：使用者手動註冊的 C:\repo\frontend 雖然也在 DB 裡，但它是別人
  // repository 的真實子目錄，仍必須走 subdirectory 的保護，不能被當成 managed project。
  const isManagedProject = !!projectRoot && samePath(cwd, projectRoot)
    && !!managedProjectsRoot && isDescendant(managedProjectsRoot, cwd);
  // `.git` 可能是資料夾（一般 repository）也可能是檔案（linked worktree）：只問存不存在。
  const hasOwnGitEntry = existsSync(join(cwd, '.git'));

  const base = {
    isGit: false,
    repositoryType: 'non-git',
    projectPath: cwd,
    worktreeRoot: null,
    gitDir: null,
    commonGitDir: null,
    mainWorktree: null,
    branch: null,
    isRepositoryRoot: false,
    isSubdirectory: false,
    isLinkedWorktree: false,
    isManagedProject,
    needsGitInit: false,
    inheritedOuterRepository: null,
    physicalParentRepository: findPhysicalParentRepository(cwd),
  };

  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (!topLevel.ok || !firstLine(topLevel.stdout)) {
    // 完全不在任何 Git context 裡。managed project 在這裡與一般空資料夾的出路相同（git init），
    // 但型別要分得出來，UI 與事件訊息才講得清楚發生了什麼事。
    return {
      ...base,
      repositoryType: isManagedProject ? 'managed-uninitialized' : 'non-git',
      isRepositoryRoot: isManagedProject,
      needsGitInit: true,
    };
  }

  const worktreeRoot = normalizePath(firstLine(topLevel.stdout));
  const gitDir = resolveGitPath(cwd, git(cwd, ['rev-parse', '--git-dir'], { allowFailure: true }).stdout);
  const commonGitDir = resolveGitPath(cwd, git(cwd, ['rev-parse', '--git-common-dir'], { allowFailure: true }).stdout);
  const branchResult = git(cwd, ['branch', '--show-current'], { allowFailure: true });
  const branch = branchResult.ok ? firstLine(branchResult.stdout) || null : null;

  const facts = { ...base, isGit: true, worktreeRoot, gitDir, commonGitDir, branch };

  if (!samePath(cwd, worktreeRoot)) {
    // Git 說 working tree root 在上層。兩種可能，差別在這個路徑是不是 TaskFlow 自己的專案 root。
    if (isManagedProject && !hasOwnGitEntry) {
      // TaskFlow 建立的專案，還沒有自己的 .git，於是 --show-toplevel 穿透到了父 repository。
      // 這不是 nested repository，而是「尚未初始化 Git 的 TaskFlow 專案」。
      return {
        ...base,
        repositoryType: 'managed-uninitialized',
        isGit: false,
        isRepositoryRoot: true,
        needsGitInit: true,
        inheritedOuterRepository: worktreeRoot,
      };
    }
    // 真正的 repository 子目錄：TaskFlow 不會替使用者在上層 repository 開分支或改內容。
    return { ...facts, repositoryType: 'subdirectory', isSubdirectory: true };
  }

  // 到這裡 projectPath == show-toplevel，它就是一個合法的 working tree root。
  // 此後不得因為 filesystem 上層還有另一個 .git 而把它降級成 nested／subdirectory。
  const worktrees = parseWorktreeList(git(cwd, ['worktree', 'list', '--porcelain'], { allowFailure: true }).stdout);
  const listed = worktrees.some(entry => samePath(entry.path, worktreeRoot));
  // gitDir != commonGitDir 是 linked worktree 的主要訊號，但不是充分條件，
  // 所以再用 worktree 清單確認目前這個 root 真的登記在案（規格書第 11 節）。
  if (gitDir && commonGitDir && !samePath(gitDir, commonGitDir) && listed) {
    return {
      ...facts,
      repositoryType: 'linked-worktree',
      isRepositoryRoot: true,
      isLinkedWorktree: true,
      mainWorktree: worktrees[0]?.path || null,
    };
  }

  return {
    ...facts,
    // nested-independent 與 normal 的差別純粹是 diagnostic（實體上還有沒有外層 repository），
    // 兩者的 policy 完全相同，都是合法的 repository root。
    repositoryType: facts.physicalParentRepository ? 'nested-independent' : 'normal',
    isRepositoryRoot: true,
    mainWorktree: worktrees[0]?.path || null,
  };
}

/**
 * topology → 決策。detection 不碰決策，決策不重做 detection。
 *
 *   nextAction 'continue'    可以直接往下走（開分支、建立 worktree、commit、驗收）
 *   nextAction 'git-init'    TaskFlow 自己初始化這個專案的 repository，不需要人介入
 *   nextAction 'user-action' 必須由使用者處理，流程停止
 *
 * @param {RepositoryInfo} info
 * @returns {{blocked:boolean,requiresUserAction:boolean,nextAction:'continue'|'git-init'|'user-action',blockReason:string|null}}
 */
export function evaluateRepositoryPolicy(info) {
  switch (info?.repositoryType) {
    case 'normal':
    case 'nested-independent':
    case 'linked-worktree':
      return { blocked: false, requiresUserAction: false, nextAction: 'continue', blockReason: null };
    case 'managed-uninitialized':
    case 'non-git':
      return { blocked: false, requiresUserAction: false, nextAction: 'git-init', blockReason: null };
    case 'subdirectory':
      return { blocked: true, requiresUserAction: true, nextAction: 'user-action', blockReason: 'repository-subdirectory' };
    default:
      // 認不出來的 topology 一律停下來問人。放行一個看不懂的狀態，比多問一次危險得多。
      return { blocked: true, requiresUserAction: true, nextAction: 'user-action', blockReason: 'unknown-repository-type' };
  }
}
