import {now} from './db.js';

// Conservative, reversible-only normalization: collapse whitespace and drop quotes around a
// single unquoted-looking token (e.g. `node ".taskflow/x.cjs"` -> `node .taskflow/x.cjs`).
// Never reorders arguments, changes shell operators, or unquotes tokens containing spaces.
export function normalizeCommand(command) {
  return String(command).trim().replace(/\s+/g, ' ').replace(/(["'])([^"'\s]+)\1/g, '$2');
}

// Never let a one-off approval flow auto-authorize an operation with irreversible or
// destructive blast radius; these always fall back to the existing manual (completed/failed/skip) path.
const HIGH_RISK_PATTERNS = [
  /\bgit\s+push\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\breg(?:\.exe)?\s+delete\b/i,
  /\b(?:del|erase)\b.*\/s\b/i,
  /\brmdir\b.*\/s\b/i,
  /\brm\s+-\w*r\w*f\w*\b/i,
  /\bremove-item\b.*-recurse\b/i,
];
export function isHighRiskCommand(command) {
  return HIGH_RISK_PATTERNS.some(p => p.test(String(command)));
}

// Approvals are scoped to the exact task workspace they were granted in and never carry over
// to a different cwd or a different command.
export function matchingCommandApprovals(task, cwd) {
  return (task.commandApprovals || []).filter(a => a.status === 'approved' && a.cwd === cwd);
}
// Include both the originally-blocked literal command and its normalized form: the retried
// attempt may re-issue the command with different quoting, and either form must match.
export function approvedCommandRules(approvals) {
  return approvals.flatMap(a => a.command === a.normalizedCommand ? [`Bash(${a.command})`] : [`Bash(${a.command})`, `Bash(${a.normalizedCommand})`]);
}
// One-shot: once a grant has been handed to a CLI invocation, it is spent whether or not the
// agent actually issued the command during that run — never left around to be reused silently.
export function consumeCommandApprovals(task, ids) {
  if (!ids.length) return;
  const set = new Set(ids);
  task.commandApprovals = (task.commandApprovals || []).map(a => set.has(a.id) ? { ...a, status: 'consumed', consumedAt: now() } : a);
}

// Trusted project scripts run with the local user's privileges, not in an OS sandbox.
// Keep the grant attached to each execution session, never global CLI settings.
const commands = [
  'npm install', 'npm ci', 'npm test',
  'pnpm install', 'pnpm test', 'yarn install', 'yarn test',
  ...['npm', 'pnpm', 'yarn'].flatMap(manager =>
    ['build', 'test', 'lint', 'typecheck', 'check', 'dev', 'preview'].map(script => `${manager} run ${script}`)),
];
export const developmentCommandRules = commands.flatMap(command =>
  [`Bash(${command})`, `Bash(${command} *)`]);
export function commandPermissionArgs(engine, readOnly, platform=process.platform) {
  // Downloads are part of the approved development work. Keep filesystem isolation.
  if(engine==='codex')return [...(platform==='win32'?['-c','windows.sandbox="elevated"']:[]),...(!readOnly?['-c','sandbox_workspace_write.network_access=true']:[])];
  return engine === 'claude' && !readOnly ? ['--allowedTools', ...developmentCommandRules] : [];
}
