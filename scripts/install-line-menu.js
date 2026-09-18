import 'dotenv/config';
import {readFileSync,writeFileSync} from 'node:fs';
if(!process.env.INBOX_URL||!process.env.INBOX_TOKEN)throw new Error('Cloud inbox is not configured');
const imageBase64=readFileSync(new URL('../cloud-inbox/assets/rich-menu.png',import.meta.url)).toString('base64');
const response=await fetch(process.env.INBOX_URL+'/runner/menu/install',{method:'POST',headers:{Authorization:`Bearer ${process.env.INBOX_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({imageBase64}),signal:AbortSignal.timeout(90000)});
const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));
writeFileSync('data/line-menu-deployment.json',JSON.stringify({...result,at:new Date().toISOString()},null,2));console.log(JSON.stringify(result));
