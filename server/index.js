import 'dotenv/config';
import { createStore } from './db.js';
import { createRunner } from './runner.js';
import { createApp } from './app.js';
import { createBridge } from './line.js';
import { createProjectPreview } from './project-preview.js';
const store=createStore();
if(!store.db.prepare('SELECT id FROM users LIMIT 1').get()){console.error('請先執行 npm run setup 建立管理者。');process.exit(1);}
const previews=createProjectPreview();
const runner=createRunner(store,{previews}),bridge=createBridge(store,{runner}),app=createApp(store,runner,{previews});
const server=app.listen(Number(process.env.PORT||4310),process.env.HOST||'127.0.0.1',()=>console.log(`TaskFlow: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||4310}`));
function stop(){runner.stop();bridge.stop();void app.locals.previews.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),3000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
