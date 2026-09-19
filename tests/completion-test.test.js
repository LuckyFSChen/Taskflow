import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, id } from '../server/db.js';
import { createTask, approveTask } from '../server/domain.js';
import { createRunner } from '../server/runner.js';
import { createGitWorkspace } from '../server/git-workspace.js';
import { createCompletionTests, completionTestPublic, recoverCompletionTests } from '../server/completion-test.js';

const plan = { summary: '建立文件', acceptance: ['有文件'], questions: [], steps: [{ title: '撰寫文件', role: '作者', instructions: '完成文件' }] };
const good = { summary: '驗證完成', questions: [], artifacts: ['result.md'], passed: true, evidence: ['已讀取 result.md'] };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// 一份 TAP 輸出；failures 是要標記為失敗的測試名稱。格式照 `node --test` 的實際輸出寫。
// root 一定要用「這次實際執行的目錄」：基準跑在專案目錄、本次跑在 worktree，兩者的絕對路徑
// 本來就不同，識別碼必須被還原成相對路徑才比得起來——這正是要驗的性質。
function tap(names, failures = [], root) {
  const body = names.map((name, index) => {
    const failed = failures.includes(name);
    return `# Subtest: ${name}\n${failed ? 'not ok' : 'ok'} ${index + 1} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  location: '${root}/tests/suite.test.js:${index + 1}:1'\n  ...`;
  }).join('\n');
  return `TAP version 13\n${body}\n1..${names.length}\n# tests ${names.length}\n# suites 0\n# pass ${names.length - failures.length}\n# fail ${failures.length}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 10\n`;
}

// 跑完一個真實的任務流程，停在「已完成、等待人工審核」；與 tests/git-review.test.js 同一套做法。
async function completedTask(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tf-completion-')), store = createStore(join(dir, 'db.sqlite'));
  const owner = store.addUser('Owner', 'owner', 'password-owner-123'), projectId = id();
  const source = join(dir, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'README.md'), '# 原始專案\n');
  store.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(projectId, 'demo', 'Demo', source);
  store.db.prepare('INSERT INTO memberships VALUES (?,?)').run(owner.id, projectId);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  let calls = 0;
  const runner = createRunner(store, {
    dataDir: join(dir, 'runs'), recover: false,
    adapter: async o => { calls++; if (o.readOnly) return { result: plan }; if (calls === 2) writeFileSync(join(o.cwd, 'result.md'), 'delivered\n'); return { result: good }; },
  });
  t.after(() => runner.stop());
  store.setSetting('runnerEnabled', true);

  const task = createTask(store, owner, { title: 'Document task', description: 'Create a document and validate it.', projectId, type: 'research', priority: 1, planner: 'claude', executor: 'codex', reviewer: 'claude' });
  await runner.tick();
  approveTask(store, owner, task.id, 1);
  await runner.tick();
  await runner.tick();
  assert.equal(store.task(task.id).status, 'completed');
  return { dir, store, owner, source, projectId, task: store.task(task.id) };
}

// 假的 npm 執行器：記錄每次呼叫，依 cwd 決定要回哪一份 TAP。
function fakeNpm({ baseline, current, onInstall } = {}) {
  const calls = [];
  return {
    calls,
    run: async options => {
      calls.push({ cwd: options.cwd, args: options.args });
      if (options.args[0] === 'install') return onInstall?.(options) || { exitCode: 0, timedOut: false, truncated: false, output: '', logPath: null, durationMs: 10 };
      const spec = calls.filter(c => c.args[0] === 'test').length === 1 && baseline !== undefined ? baseline : current;
      // TAP 由這次執行的 cwd 產生，模擬 node --test 印出的絕對路徑。
      const output = typeof spec === 'function' ? spec(options.cwd) : spec;
      return { exitCode: 0, timedOut: false, truncated: false, output, logPath: options.logPath || null, durationMs: 100 };
    },
  };
}

test('沒有新增失敗時判定 no_regression，並在兩個目錄各跑一次測試', async t => {
  const f = await completedTask(t);
  const npm = fakeNpm({ baseline: cwd => tap(['a', 'b', 'c'], ['c'], cwd), current: cwd => tap(['a', 'b', 'c'], ['c'], cwd) });
  const tests = createCompletionTests({ gitWorkspace: createGitWorkspace(), run: npm.run, dataDir: join(f.dir, 'data') });

  tests.start(f.store, f.owner, f.task.id);
  assert.equal(f.store.task(f.task.id).completionTest.status, 'running');
  await tests.settled();

  const report = f.store.task(f.task.id).completionTest;
  assert.equal(report.status, 'completed');
  assert.equal(report.verdict, 'no_regression');
  assert.deepEqual(report.newFailures, []);
  assert.equal(report.baseline.total, 3);
  assert.equal(report.current.total, 3);

  // 既有失敗（c）在這次沒有新增、也還沒修好，兩個公開欄位應該一致回報同一項。
  const publicReport = completionTestPublic(f.store.task(f.task.id));
  assert.equal(publicReport.existingFailureCount, 1);
  assert.equal(publicReport.unchangedFailureCount, 1);

  const suites = npm.calls.filter(c => c.args[0] === 'test');
  assert.equal(suites.length, 2);
  assert.equal(suites[0].cwd, f.source);                       // 基準跑在專案目錄（main）
  assert.equal(suites[1].cwd, f.store.task(f.task.id).workspace); // 本次跑在任務 worktree
});

test('任務分支多出失敗時判定 regression，並指名新增的項目', async t => {
  const f = await completedTask(t);
  const npm = fakeNpm({ baseline: cwd => tap(['a', 'b', 'c'], ['c'], cwd), current: cwd => tap(['a', 'b', 'c'], ['b', 'c'], cwd) });
  const tests = createCompletionTests({ gitWorkspace: createGitWorkspace(), run: npm.run, dataDir: join(f.dir, 'data') });

  tests.start(f.store, f.owner, f.task.id);
  await tests.settled();

  const report = f.store.task(f.task.id).completionTest;
  assert.equal(report.verdict, 'regression');
  assert.deepEqual(report.newFailures, ['tests/suite.test.js > b']);
  assert.ok(f.store.events(f.task.id).some(e => e.kind === 'completion_test_result' && /1 項新的失敗/.test(e.message)));
});

test('基準以 commit 為 key 快取：main 沒動就不重跑', async t => {
  const f = await completedTask(t);
  const npm = fakeNpm({ baseline: cwd => tap(['a', 'b'], [], cwd), current: cwd => tap(['a', 'b'], [], cwd) });
  const tests = createCompletionTests({ gitWorkspace: createGitWorkspace(), run: npm.run, dataDir: join(f.dir, 'data') });

  tests.start(f.store, f.owner, f.task.id);
  await tests.settled();
  const first = npm.calls.filter(c => c.args[0] === 'test').length;

  tests.start(f.store, f.owner, f.task.id);
  await tests.settled();
  const second = npm.calls.filter(c => c.args[0] === 'test').length;

  assert.equal(first, 2);
  assert.equal(second, 3); // 只多跑了任務分支那一次
  assert.equal(f.store.task(f.task.id).completionTest.baseline.cached, true);
});

test('專案目錄不在正式分支上時，不假裝那是基準，也不浪費時間跑它', async t => {
  const f = await completedTask(t);
  git(f.source, 'checkout', '-b', 'elsewhere');
  const npm = fakeNpm({ current: cwd => tap(['a'], [], cwd) });
  const tests = createCompletionTests({ gitWorkspace: createGitWorkspace(), run: npm.run, dataDir: join(f.dir, 'data') });

  tests.start(f.store, f.owner, f.task.id);
  await tests.settled();

  const report = f.store.task(f.task.id).completionTest;
  assert.equal(report.verdict, 'baseline_unavailable');
  assert.equal(report.baseline.reason, 'not_on_base_branch');
  assert.equal(npm.calls.filter(c => c.args[0] === 'test').length, 1);
});

test('測試輸出讀不懂時判定 parse_failed，絕不當成通過', async t => {
  const f = await completedTask(t);
  const npm = fakeNpm({ baseline: cwd => tap(['a'], [], cwd), current: 'npm ERR! Missing script: "test"' });
  const tests = createCompletionTests({ gitWorkspace: createGitWorkspace(), run: npm.run, dataDir: join(f.dir, 'data') });

  tests.start(f.store, f.owner, f.task.id);
  await tests.settled();

  const report = f.store.task(f.task.id).completionTest;
  assert.equal(report.verdict, 'parse_failed');
  assert.equal(report.current.ok, false);
  assert.equal(report.current.reason, 'not_tap');
});

test('工作副本沒有 node_modules 時會先安裝；安裝失敗就照實回報，不硬跑測試', async t => {
  const f = await completedTask(t);
  const npm = fakeNpm({
    baseline: cwd => tap(['a'], [], cwd), current: cwd => tap(['a'], [], cwd),
    onInstall: () => ({ exitCode: 1, timedOut: false, truncated: false, output: 'install failed', logPath: null, durationMs: 50 }),
  });
  const tests = createCompletionTests({ gitWorkspace: createGitWorkspace(), run: npm.run, dataDir: join(f.dir, 'data') });

  tests.start(f.store, f.owner, f.task.id);
  await tests.settled();

  const report = f.store.task(f.task.id).completionTest;
  assert.ok(npm.calls.some(c => c.args[0] === 'install'));
  assert.equal(report.current.reason, 'install_failed');
  assert.equal(report.verdict, 'parse_failed');
});

test('AI 正在修改工作副本時拒絕執行', async t => {
  const f = await completedTask(t);
  const thread = f.store.threads(f.task.id)[0];
  f.store.saveThread({ ...thread, status: 'running' });
  const tests = createCompletionTests({ gitWorkspace: createGitWorkspace(), run: async () => ({ exitCode: 0, output: '', durationMs: 1 }), dataDir: join(f.dir, 'data') });

  assert.throws(() => tests.start(f.store, f.owner, f.task.id), /AI 正在修改/);
});

test('同一時間只跑一組比對', async t => {
  const f = await completedTask(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const tests = createCompletionTests({
    gitWorkspace: createGitWorkspace(), dataDir: join(f.dir, 'data'),
    run: async options => { await gate; return { exitCode: 0, timedOut: false, truncated: false, output: tap(['a'], [], options.cwd), logPath: options.logPath || null, durationMs: 1 }; },
  });

  tests.start(f.store, f.owner, f.task.id);
  assert.throws(() => tests.start(f.store, f.owner, f.task.id), /正在執行中/);
  release();
  await tests.settled();
});

test('服務重啟後，中斷的比對不會永遠停在執行中', async t => {
  const f = await completedTask(t);
  const task = f.store.task(f.task.id);
  task.completionTest = { id: 'x', status: 'running', startedAt: new Date().toISOString() };
  f.store.saveTask(task);

  recoverCompletionTests(f.store);

  const report = f.store.task(f.task.id).completionTest;
  assert.equal(report.status, 'interrupted');
  assert.match(report.error, /重新啟動/);
  assert.ok(f.store.events(f.task.id).some(e => e.kind === 'completion_test_interrupted'));
});

test('送到瀏覽器的版本不含伺服器磁碟路徑', () => {
  const report = completionTestPublic({
    completionTest: {
      id: 'x', status: 'completed', verdict: 'no_regression', newFailures: [], resolvedFailures: [],
      baseline: { ok: true, total: 3, passed: 2, failed: ['tests/a.test.js > x'], logPath: 'F:\\TaskFlow\\data\\completion\\x\\baseline.log' },
      current: { ok: true, total: 3, passed: 2, failed: ['tests/a.test.js > x'], logPath: 'F:\\TaskFlow\\data\\completion\\x\\current.log' },
    },
  });
  assert.equal(JSON.stringify(report).includes('TaskFlow'), false);
  assert.equal(report.baseline.logPath, undefined);
  assert.equal(report.baseline.failedCount, 1);
  assert.equal(completionTestPublic({}), null);
});
