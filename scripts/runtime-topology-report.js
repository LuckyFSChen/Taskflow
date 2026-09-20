// 診斷用：印出某個專案目錄被 TaskFlow 判定成什麼 runtime topology。
// 用法：node scripts/runtime-topology-report.js <projectPath>
import {resolveRuntimeTopology, topologyPublic} from '../server/runtime-topology.js';
import {detectWebProject} from '../server/project-preview.js';

const path = process.argv[2];
if (!path) { console.error('用法：node scripts/runtime-topology-report.js <projectPath>'); process.exit(1); }

try {
  const topology = resolveRuntimeTopology(path);
  console.log('detectWebProject:', detectWebProject(path));
  if (!topology) { console.log('topology: null（單一服務專案，走既有 Preview 流程）'); process.exit(0); }
  console.log(JSON.stringify(topologyPublic(topology), null, 2));
} catch (error) {
  console.error('topology 解析失敗：', error.message);
  process.exit(2);
}
