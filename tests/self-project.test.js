import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {snapshot} from '../server/runner.js';
test('Platform self-project snapshot excludes live data, nested projects and Cloudflare secrets',t=>{
 const root=mkdtempSync(join(tmpdir(),'tf-self-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const projects=join(root,'Projects'),dest=join(root,'data/workspaces/test');
 mkdirSync(projects);mkdirSync(join(root,'cloud-inbox/.wrangler'),{recursive:true});
 writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'.env'),'secret');writeFileSync(join(root,'cloud-inbox/.dev.vars.local'),'secret');
 snapshot(root,dest,{excludePaths:[projects]});
 assert.ok(existsSync(join(dest,'package.json')));for(const name of ['data','Projects','.env','cloud-inbox/.wrangler','cloud-inbox/.dev.vars.local'])assert.equal(existsSync(join(dest,name)),false);
});
