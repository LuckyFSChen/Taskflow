import 'dotenv/config';
import { createStore } from '../server/db.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync,existsSync } from 'node:fs';
import { mainServerOrigin, TASKFLOW_GUARDIAN_PORT, TASKFLOW_MAIN_PORT } from '../server/ports.js';
const store=createStore();
if(!store.db.prepare('SELECT id FROM users LIMIT 1').get()) {
  const password=randomBytes(18).toString('base64url');
  store.addUser('管理者','admin',password,'admin');
  writeFileSync('data/first-login.txt',`TaskFlow 首次登入\n網址：${mainServerOrigin()}\n帳號：admin\n密碼：${password}\n請登入後在設定頁修改密碼，並刪除此檔。\n`,{mode:0o600});
  console.log('管理者已建立；首次登入資訊存於 data/first-login.txt（不會輸出至紀錄）。');
} else console.log('管理者已存在，不覆寫帳號。');
// TASKFLOW_PORT 而不是泛用的 PORT：PORT 屬於 Task／Preview runtime，寫在這裡會回流污染主服務。
if(!existsSync('.env')) writeFileSync('.env',`TASKFLOW_PORT=${TASKFLOW_MAIN_PORT}\nTASKFLOW_GUARDIAN_PORT=${TASKFLOW_GUARDIAN_PORT}\nHOST=127.0.0.1\nPUBLIC_ORIGIN=http://127.0.0.1:${TASKFLOW_MAIN_PORT}\nCOOKIE_SECURE=false\n`);
store.close();
