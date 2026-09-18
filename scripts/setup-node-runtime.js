import {cpSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
const source=dirname(process.execPath),target=resolve('data/tools/node');
const files=['node.exe','npm.cmd','npx.cmd','node_modules/npm'];
for(const file of files)if(!existsSync(join(source,file)))throw new Error('Missing installed Node component: '+file);
mkdirSync(target,{recursive:true});
for(const file of files)cpSync(join(source,file),join(target,file),{recursive:true});
console.log('TaskFlow Node/npm runtime: '+target);
