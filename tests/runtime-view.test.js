// UI 層對 runtime_blocked 的呈現（計畫書第二十八章）。
//
// 要守住的是同一件事的另一面：使用者看到的不能只是「驗證失敗」，
// 必須看得出卡在哪一層、是誰的責任、下一步能做什麼。
import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionCategory, attentionItems} from '../src/attention.js';
import {pendingActions, pendingBanner, hasPendingActions} from '../src/task-detail-view.js';

const runtimeIssue = (overrides = {}) => ({
  id: 'ri-1', state: 'runtime_blocked', failureKind: 'proxy_routing_failure', owner: 'taskflow',
  attempts: 2, planVersion: 1, message: 'Runtime preflight 未通過（前端到後端的轉發未生效）',
  checks: [
    {name: 'frontend_root', expected: '200 text/html', actual: '200 text/html', passed: true, detail: null},
    {name: 'frontend_proxy:/api/health', expected: 'application/json', actual: '200 text/html', passed: false, failureKind: 'proxy_routing_failure', detail: 'expected application/json, received text/html，且 body 是 HTML 文件（SPA fallback）。'},
  ],
  ...overrides,
});

test('runtime_blocked 在「待我處理」裡是自己的分類，說得出卡在哪一條路徑', () => {
  const task = {id: 't1', status: 'failed', displayStatus: 'failed', runtimeIssue: runtimeIssue()};
  const category = attentionCategory(task);
  assert.equal(category.type, 'runtime_blocked');
  assert.match(category.title, /執行環境未就緒/);
  assert.match(category.reason, /frontend_proxy:\/api\/health/, '要指名是哪一條路徑失敗');
  assert.match(category.reason, /expected application\/json/);
  assert.match(category.description, /不是專案的程式問題/, '要講清楚這不該由 Repair Agent 處理');
});

test('topology 判定不出來時，標題改成「需要你宣告要啟動哪些服務」', () => {
  const task = {id: 't2', status: 'waiting_input', displayStatus: 'waiting_input',
    runtimeIssue: runtimeIssue({owner: 'user', failureKind: 'topology_unresolved', checks: []}),
    questions: ['請在專案根目錄新增 taskflow.runtime.json…']};
  const category = attentionCategory(task);
  assert.equal(category.type, 'runtime_blocked');
  assert.match(category.title, /宣告/);
  assert.match(category.description, /runtime 宣告/);
});

test('Task Drawer 把 runtime_blocked 列為待處理項目，且會擋住執行步驟顯示成「進行中」', () => {
  const task = {id: 't3', status: 'failed', displayStatus: 'failed', runtimeIssue: runtimeIssue(),
    plan: {steps: [{title: 'a'}, {title: 'b'}]}, threads: [], completedSteps: 0};
  const pending = pendingActions(task);
  assert.ok(pending.some(item => item.id === 'runtime_blocked'));
  assert.equal(hasPendingActions(task), true);
  const item = pending.find(entry => entry.id === 'runtime_blocked');
  assert.match(item.title, /執行環境未就緒/);
  assert.match(item.description, /尚未交給修正流程/);
  // 其他分頁看得到「還有事情要處理」的提示。
  assert.equal(pendingBanner(task).count, pending.length);
});

test('沒有 runtimeIssue 的任務不會冒出這個分類', () => {
  assert.equal(attentionItems([{id: 'ok', status: 'running', displayStatus: 'running', threads: []}]).some(item => item.type === 'runtime_blocked'), false);
});
