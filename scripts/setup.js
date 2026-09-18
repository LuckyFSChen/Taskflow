import 'dotenv/config';
import { createStore } from '../server/db.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync,existsSync } from 'node:fs';
const store=createStore();
if(!store.db.prepare('SELECT id FROM users LIMIT 1').get()) {
  const password=randomBytes(18).toString('base64url');
  store.addUser('管理者','admin',password,'admin');
  writeFileSync('data/first-login.txt',`TaskFlow 首次登入\n網址：http://127.0.0.1:4310\n帳號：admin\n密碼：${password}\n請登入後在設定頁修改密碼，並刪除此檔。\n`,{mode:0o600});
  console.log('管理者已建立；首次登入資訊存於 data/first-login.txt（不會輸出至紀錄）。');
} else console.log('管理者已存在，不覆寫帳號。');
if(!existsSync('.env')) writeFileSync('.env','PORT=4310\nHOST=127.0.0.1\nPUBLIC_ORIGIN=http://127.0.0.1:4310\nCOOKIE_SECURE=false\n');
store.close();
