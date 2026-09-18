import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {parse} from 'dotenv';
mkdirSync('data',{recursive:true});
let text=readFileSync('.env','utf8');
const env=parse(text);
const token=env.INBOX_TOKEN||randomBytes(32).toString('base64url');
if(!env.INBOX_TOKEN){text=text.replace(/^INBOX_TOKEN=.*\r?\n?/m,'');text+=`\nINBOX_TOKEN=${token}\n`;writeFileSync('.env',text,{mode:0o600});}
writeFileSync('data/cloud-secrets.json',JSON.stringify({INBOX_TOKEN:token}),{mode:0o600});
console.log('Local runner secret prepared; secret value was not printed.');
