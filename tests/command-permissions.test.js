import test from 'node:test';
import assert from 'node:assert/strict';
import {commandPermissionArgs,developmentCommandRules} from '../server/command-permissions.js';
test('development permissions grant network to Codex execution while keeping planning unchanged',()=>{
  assert.deepEqual(commandPermissionArgs('claude',true),[]);
  assert.deepEqual(commandPermissionArgs('codex',true,'linux'),[]);
  assert.deepEqual(commandPermissionArgs('codex',false,'linux'),['-c','sandbox_workspace_write.network_access=true']);
  assert.deepEqual(commandPermissionArgs('codex',true,'win32'),['-c','windows.sandbox="elevated"']);
  assert.deepEqual(commandPermissionArgs('codex',false,'win32'),['-c','windows.sandbox="elevated"','-c','sandbox_workspace_write.network_access=true']);
  assert.ok(commandPermissionArgs('claude',false).includes('Bash(npm install)'));
  assert.ok(developmentCommandRules.includes('Bash(npm run build *)'));
  assert.ok(!developmentCommandRules.some(rule=>/publish|deploy|push/.test(rule)));
  assert.ok(!developmentCommandRules.includes('Bash'));
  assert.ok(!developmentCommandRules.includes('Bash(npm run *)'));
});
