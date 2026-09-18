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
