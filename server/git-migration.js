// Phase 3：把既有的 v1/v2 工作副本轉進 Git 模式。
//
// 原則（對應規劃書 2.7）：不刪除任何既有的工作副本。這裡做的是「複製一份進任務分支」，
// 舊資料夾原封不動留在 data/workspaces 下，轉換失敗或結果不如預期時還找得回來。
// 只有使用者自己按下轉換才會執行；已完成或已取消的舊任務不必動，維持相容即可。
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { HttpError, requireTask } from './domain.js';
import { createGitWorkspace, isUnsafeToCommit, DEFAULT_PROTECTED_BRANCHES } from './git-workspace.js';
import { now } from './db.js';

const shared = createGitWorkspace();

function copyInto(source, target) {
  const copied = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || isUnsafeToCommit(entry.name)) continue;
      const from = join(dir, entry.name), to = join(target, relative(source, from));
      if (entry.isDirectory()) { mkdirSync(to, { recursive: true }); walk(from); }
      else { cpSync(from, to); copied.push(relative(source, from).replaceAll('\\', '/')); }
    }
  };
  walk(source);
  return copied;
}

// 分支上有、但舊工作副本裡沒有的檔案。可能是 AI 刪掉的，也可能是做完快照之後專案才加入的
// （甚至是轉換時 git init 產生的 .gitignore）。分不出來的事情就不要自作主張：一律不刪，
// 只把清單交給使用者判斷。誤刪是不可逆的，漏刪只是多留一個檔案。
function missingFromLegacy(legacyPath, worktree, gitWorkspace) {
  const tracked = gitWorkspace.git(worktree, ['ls-files', '-z'], { allowFailure: true }).stdout.split('\0').filter(Boolean);
  return tracked.filter(path => !path.split('/').some(isUnsafeToCommit) && !existsSync(join(legacyPath, path)));
}

export function legacyWorkspaceStatus(store, user, tid) {
  const t = requireTask(store, user, tid);
  const legacy = !t.git && !!t.workspace;
  return {
    legacy,
    migratable: legacy && existsSync(t.workspace) && !store.threads(t.id).some(th => th.status === 'running'),
    workspaceExists: !!t.workspace && existsSync(t.workspace),
    migratedFrom: t.legacyWorkspace || null,
  };
}

export function migrateLegacyWorkspace(store, user, tid, { gitWorkspace = shared, dataDir = resolve('data') } = {}) {
  const t = requireTask(store, user, tid);
  if (t.git) throw new HttpError(409, '此任務已經在 Git 模式下執行。');
  if (!t.workspace || !existsSync(t.workspace)) throw new HttpError(409, '找不到此任務的既有工作副本，沒有可轉換的內容。');
  if (store.threads(t.id).some(th => th.status === 'running')) throw new HttpError(409, '目前工作尚未停止，請先暫停後再轉換。');
  const project = store.project(t.projectId);
  if (!project || !existsSync(project.path)) throw new HttpError(409, '專案資料夾不存在，無法轉換。');
  if (!gitWorkspace.available(project.path)) throw new HttpError(409, '找不到可用的 git 指令，無法轉換。');

  const legacyPath = t.workspace;
  // Phase 1 的所有守門（未提交修改、受保護分支、巢狀版本庫…）在這裡照樣生效。
  const prepared = gitWorkspace.prepare({
    projectPath: project.path, taskId: t.id, title: t.title,
    worktreesDir: join(dataDir, 'worktrees'),
    protectedBranches: store.setting('protectedBranches', DEFAULT_PROTECTED_BRANCHES),
  });
  for (const e of prepared.events) store.event(t.id, e.kind, e.message);

  const worktree = prepared.git.workingDirectory;
  const copied = copyInto(legacyPath, worktree);
  const missing = missingFromLegacy(legacyPath, worktree, gitWorkspace);

  const outcome = gitWorkspace.commit({
    workingDirectory: worktree, workingBranch: prepared.git.workingBranch,
    protectedBranches: store.setting('protectedBranches', DEFAULT_PROTECTED_BRANCHES),
    subject: 'taskflow(migrate): 匯入既有工作副本',
    body: [
      `任務：${t.title}（${t.id}）`,
      `來源：舊版工作副本 ${legacyPath}`,
      `轉換：${user.name}（${user.id}）於 ${now()}`,
      `複製 ${copied.length} 個檔案。`,
      ...(missing.length ? [`分支上有但舊工作副本裡沒有的檔案（未自動刪除，請自行確認）：${missing.slice(0, 20).join('、')}`] : []),
      '舊資料夾保留原處，未刪除。commit 只保存成果，不代表驗收通過。',
    ].join('\n'),
  });

  t.legacyWorkspace = legacyPath;
  t.workspace = worktree;
  t.git = { ...prepared.git, headCommit: outcome.committed ? outcome.commit : prepared.git.headCommit, migratedFromLegacy: true };
  store.saveTask(t);
  store.event(t.id, 'git_migrated',
    `已將既有工作副本轉入分支 ${prepared.git.workingBranch}（複製 ${copied.length} 個檔案${outcome.committed ? `，commit ${outcome.commit.slice(0, 8)}` : '，內容與基準相同故未產生 commit'}）。舊資料夾保留原處。`);
  if (missing.length) store.event(t.id, 'git_migrated',
    `以下檔案在分支上存在、但舊工作副本裡沒有，可能是先前被刪除、也可能是之後才加入的。TaskFlow 不會自行刪除，請自行確認：${missing.slice(0, 20).join('、')}`);
  return t;
}

export { copyInto as copyLegacyWorkspaceInto };
