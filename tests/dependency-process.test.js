import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dependencyPreflight} from '../server/dependency-preflight.js';

test('registry reachability alone cannot pass a failed subprocess check',async t=>{
  const cwd=mkdtempSync(join(tmpdir(),'tf-process-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  await assert.rejects(dependencyPreflight(async options=>{
    assert.ok(existsSync(join(cwd,'.taskflow','probe-child-process.cjs')));
    assert.match(options.prompt,/node \.taskflow\/probe-child-process.cjs/);
    assert.match(options.prompt,/不能由 npm ping 成功推定/);
    return {result:{summary:'Child process denied',toolAvailable:true,registryReachable:true,installationAllowed:false,evidence:['node-child: EPERM','npm-script-shell: EPERM']}};
  },{cwd,runDir:join(cwd,'run')}),e=>e.code==='DEPENDENCY_PREFLIGHT'&&e.report.registryReachable&&/EPERM/.test(e.message));
});
