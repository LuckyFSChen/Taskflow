import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTapOutput,
  compareTestRuns,
  relativeTestFile,
  runTestSuite,
  testKey,
  VERDICTS,
} from '../server/test-baseline.js';

// 這些 TAP 片段刻意照 `node --test` 的實際輸出格式寫：
//   * 巢狀 subtest 縮排 4 格，YAML 區塊再縮 2 格
//   * 父測試那一行出現在所有子測試「之後」
//   * `# tests`／`# fail` 把巢狀項目一起算進去
// 解析器只要有一項對不上，就會在真實專案上整批誤判，所以格式不要簡化。

const flat = `
> taskflow-local@0.1.0 test
> node --test tests/*.test.js

TAP version 13
# Subtest: 登入成功
ok 1 - 登入成功
  ---
  duration_ms: 1.2
  type: 'test'
  ...
# Subtest: 登入失敗會擋住
not ok 2 - 登入失敗會擋住
  ---
  duration_ms: 0.8
  type: 'test'
  location: '/repo/tests/login.test.js:12:1'
  failureType: 'testCodeFailure'
  error: 'boom'
  ...
# Subtest: 略過的檢查
ok 3 - 略過的檢查 # SKIP 尚未支援
  ---
  duration_ms: 0.1
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 30
`;

const nested = `TAP version 13
# Subtest: 合併流程
    # Subtest: 乾淨時可以合併
    ok 1 - 乾淨時可以合併
      ---
      duration_ms: 0.3
      type: 'test'
      ...
    # Subtest: 衝突時擋住
    not ok 2 - 衝突時擋住
      ---
      duration_ms: 0.2
      type: 'test'
      location: '/repo/tests/git-review.test.js:40:5'
      failureType: 'testCodeFailure'
      error: 'expected conflict'
      ...
    1..2
not ok 1 - 合併流程
  ---
  duration_ms: 3.4
  type: 'test'
  location: '/repo/tests/git-review.test.js:38:1'
  failureType: 'subtestsFailed'
  ...
# Subtest: 另一個檔案的同名測試
not ok 2 - 衝突時擋住
  ---
  duration_ms: 0.2
  type: 'test'
  location: '/repo/tests/git-workspace.test.js:90:1'
  failureType: 'testCodeFailure'
  ...
1..2
# tests 4
# suites 0
# pass 1
# fail 3
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40
`;

test('解析 npm test 的完整輸出：npm 自己的前綴行不影響判讀', () => {
  const report = parseTapOutput(flat, { root: '/repo' });
  assert.equal(report.ok, true);
  assert.equal(report.total, 3);
  assert.equal(report.passed, 1);
  assert.equal(report.skipped, 1);
  assert.deepEqual(report.failed, ['tests/login.test.js > 登入失敗會擋住']);
});

test('巢狀 subtest 也要算進去，否則交叉驗證永遠對不上', () => {
  const report = parseTapOutput(nested, { root: '/repo' });
  assert.equal(report.ok, true);
  // 4 = 2 個頂層 + 2 個 subtest，與 TAP 自己的 # tests 一致
  assert.equal(report.total, 4);
  assert.equal(report.failed.length, 3);
});

test('父測試那一行在子測試之後才出現，父子關係不可以接錯', () => {
  const report = parseTapOutput(nested, { root: '/repo' });
  assert.ok(report.failed.includes('tests/git-review.test.js > 合併流程 > 衝突時擋住'));
  assert.ok(report.failed.includes('tests/git-review.test.js > 合併流程'));
});

test('不同檔案的同名測試必須是不同的識別碼', () => {
  const report = parseTapOutput(nested, { root: '/repo' });
  assert.ok(report.failed.includes('tests/git-workspace.test.js > 衝突時擋住'));
  assert.equal(new Set(report.failed).size, report.failed.length);
});

test('識別碼不含行號：同一個測試搬了位置不算新的 regression', () => {
  const moved = nested.replace('git-workspace.test.js:90:1', 'git-workspace.test.js:137:1');
  const before = parseTapOutput(nested, { root: '/repo' });
  const after = parseTapOutput(moved, { root: '/repo' });
  assert.deepEqual(after.failed, before.failed);
  assert.equal(compareTestRuns(before, after).verdict, VERDICTS.NO_REGRESSION);
});

test('識別碼不含序號：前面插入新測試不算新的 regression', () => {
  const baseline = parseTapOutput(flat, { root: '/repo' });
  const renumbered = flat
    .replace('not ok 2 - 登入失敗會擋住', 'not ok 7 - 登入失敗會擋住')
    .replace('# tests 3', '# tests 3');
  const current = parseTapOutput(renumbered, { root: '/repo' });
  assert.deepEqual(current.failed, baseline.failed);
});

test('輸出不是 TAP 時判為 parse_failed，不得當成沒有失敗', () => {
  const report = parseTapOutput('npm ERR! Missing script: "test"');
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'not_tap');
  assert.deepEqual(report.failed, []);
  assert.equal(compareTestRuns(parseTapOutput(flat, { root: '/repo' }), report).verdict, VERDICTS.PARSE_FAILED);
});

test('數量與 TAP 摘要不符時判為 parse_failed（失敗清單可能不完整）', () => {
  const tampered = flat.replace('# fail 1', '# fail 2');
  const report = parseTapOutput(tampered, { root: '/repo' });
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'summary_mismatch');
});

test('缺少摘要行時判為 parse_failed', () => {
  const partial = flat.split('# tests 3')[0];
  assert.equal(parseTapOutput(partial, { root: '/repo' }).reason, 'no_summary');
});

test('輸出被截斷時判為 parse_failed', () => {
  assert.equal(parseTapOutput(flat, { root: '/repo', truncated: true }).reason, 'truncated');
});

test('Windows 路徑轉相對路徑：分隔符與磁碟機大小寫都要處理', () => {
  assert.equal(relativeTestFile('F:\\TaskFlow\\tests\\git-review.test.js:12:1', 'F:\\TaskFlow'), 'tests/git-review.test.js');
  assert.equal(relativeTestFile('f:/taskflow/tests/a.test.js:1:1', 'F:\\TaskFlow'), 'tests/a.test.js');
  assert.equal(relativeTestFile('/elsewhere/a.test.js:1:1', '/repo'), '/elsewhere/a.test.js');
  assert.equal(testKey('名稱', ''), '名稱');
  assert.equal(testKey('名稱', 'tests/a.test.js'), 'tests/a.test.js > 名稱');
});

test('比對：沒有新增失敗就是 no_regression，既有失敗不算數', () => {
  const baseline = parseTapOutput(flat, { root: '/repo' });
  const current = parseTapOutput(flat, { root: '/repo' });
  const outcome = compareTestRuns(baseline, current);
  assert.equal(outcome.verdict, VERDICTS.NO_REGRESSION);
  assert.deepEqual(outcome.newFailures, []);
});

test('比對：多出一項失敗就是 regression，並指名是哪一項', () => {
  const baseline = parseTapOutput(flat, { root: '/repo' });
  const current = parseTapOutput(nested, { root: '/repo' });
  const outcome = compareTestRuns(baseline, current);
  assert.equal(outcome.verdict, VERDICTS.REGRESSION);
  assert.ok(outcome.newFailures.includes('tests/git-review.test.js > 合併流程'));
  assert.deepEqual(outcome.resolvedFailures, ['tests/login.test.js > 登入失敗會擋住']);
});

test('比對：拿不到基準時不判定為通過，也不判定為 regression', () => {
  const current = parseTapOutput(flat, { root: '/repo' });
  const outcome = compareTestRuns({ ok: false, reason: 'not_on_base_branch', failed: [] }, current);
  assert.equal(outcome.verdict, VERDICTS.BASELINE_UNAVAILABLE);
});

test('runTestSuite：跑得起來就回傳結構化結果', async () => {
  const calls = [];
  const report = await runTestSuite({
    cwd: '/repo',
    commit: 'abc1234',
    label: 'baseline',
    run: async options => { calls.push(options); return { exitCode: 1, timedOut: false, truncated: false, output: flat, logPath: '/repo/data/x.log', durationMs: 1200 }; },
  });
  assert.deepEqual(calls[0].args, ['test']);
  assert.equal(calls[0].cwd, '/repo');
  assert.equal(report.ok, true);
  assert.equal(report.commit, 'abc1234');
  assert.equal(report.durationMs, 1200);
  assert.deepEqual(report.failed, ['tests/login.test.js > 登入失敗會擋住']);
});

test('runTestSuite：逾時的結果一律不採用，即使解析得出來', async () => {
  const report = await runTestSuite({
    cwd: '/repo',
    run: async () => ({ exitCode: null, timedOut: true, truncated: false, output: flat, logPath: null, durationMs: 900000 }),
  });
  assert.equal(report.ok, false);
  assert.equal(report.reason, 'timed_out');
});

test('runTestSuite：沒有注入執行器就直接拒絕，不會偷偷去跑別的東西', async () => {
  await assert.rejects(() => runTestSuite({ cwd: '/repo' }), /需要注入/);
});
