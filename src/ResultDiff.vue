<script setup lang="ts">
// 「成果」分頁的圖形化 diff 檢視：左側僅列 icon＋檔名（約 1/4 版面），右側顯示所選檔案的
// unified diff，逐行依新增／刪除／context 上色。清單資料（path/status）由外層取得後傳入；
// 這裡自己依選取的檔案呼叫 /diff/content，避免一次把所有變更檔案的內容都算出來。
import {ref,computed,watch} from 'vue';
import {FilePlus2,FilePenLine,FileMinus2,ArrowRightLeft,Copy,FileStack,GitCompare,LoaderCircle,AlertCircle} from 'lucide-vue-next';
import {api} from './api';

type DiffFile={path:string;status:string;oldPath?:string};

const props=withDefaults(defineProps<{
  taskId:string;
  files:DiffFile[];
  available?:boolean;
  message?:string;
}>(),{available:true});

const STATUS_META:Record<string,{icon:any;label:string;tone:string}>={
  added:{icon:FilePlus2,label:'新增',tone:'added'},
  modified:{icon:FilePenLine,label:'修改',tone:'modified'},
  deleted:{icon:FileMinus2,label:'刪除',tone:'deleted'},
  renamed:{icon:ArrowRightLeft,label:'重新命名',tone:'renamed'},
  copied:{icon:Copy,label:'複製',tone:'renamed'},
};
const statusMeta=(status:string)=>STATUS_META[status]||{icon:FilePenLine,label:status,tone:'modified'};

const selectedPath=ref<string|null>(null);
const diffLoading=ref(false);
const diffError=ref('');
const diffText=ref('');
const diffAvailable=ref(true);
const diffMessage=ref('');

const selectedFile=computed(()=>props.files.find(f=>f.path===selectedPath.value)||null);

async function loadDiff(file:DiffFile){
  diffLoading.value=true;diffError.value='';diffText.value='';diffAvailable.value=true;diffMessage.value='';
  try{
    const q=new URLSearchParams({path:file.path});
    if(file.oldPath)q.set('oldPath',file.oldPath);
    const result=await api(`/tasks/${props.taskId}/diff/content?${q.toString()}`);
    if(result.available===false){diffAvailable.value=false;diffMessage.value=result.message||'無法顯示差異。';}
    else diffText.value=result.diff||'';
  }catch(e:any){diffError.value=e.message||'無法載入差異內容。';}
  finally{diffLoading.value=false;}
}

function select(file:DiffFile){
  selectedPath.value=file.path;
  loadDiff(file);
}

watch(()=>[props.taskId,props.files],()=>{
  if(!props.files.some(f=>f.path===selectedPath.value)){
    selectedPath.value=null;diffText.value='';diffError.value='';
    if(props.files.length)select(props.files[0]);
  }
},{immediate:true});

type DiffLine={type:'hunk'|'add'|'del'|'context'|'meta'|'binary';text:string;oldNo:number|null;newNo:number|null};
const SKIP_PREFIXES=['diff --git ','index ','--- ','+++ '];
const META_PREFIXES=['new file mode','deleted file mode','old mode','new mode','similarity index','rename from','rename to','copy from','copy to'];

const diffLines=computed<DiffLine[]>(()=>{
  if(!diffText.value)return [];
  const lines=diffText.value.split('\n');
  const out:DiffLine[]=[];
  let oldNo=0,newNo=0;
  for(const raw of lines){
    if(raw==='')continue;
    if(SKIP_PREFIXES.some(p=>raw.startsWith(p)))continue;
    if(raw.startsWith('Binary files ')){out.push({type:'binary',text:raw,oldNo:null,newNo:null});continue;}
    if(META_PREFIXES.some(p=>raw.startsWith(p))){out.push({type:'meta',text:raw,oldNo:null,newNo:null});continue;}
    if(raw.startsWith('@@')){
      const m=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      oldNo=m?parseInt(m[1],10):0;newNo=m?parseInt(m[2],10):0;
      out.push({type:'hunk',text:raw,oldNo:null,newNo:null});
      continue;
    }
    if(raw.startsWith('\\')){out.push({type:'meta',text:raw,oldNo:null,newNo:null});continue;}
    if(raw.startsWith('+')){out.push({type:'add',text:raw.slice(1),oldNo:null,newNo:newNo});newNo++;continue;}
    if(raw.startsWith('-')){out.push({type:'del',text:raw.slice(1),oldNo:oldNo,newNo:null});oldNo++;continue;}
    out.push({type:'context',text:raw.slice(1),oldNo:oldNo,newNo:newNo});oldNo++;newNo++;
  }
  return out;
});
</script>

<template>
  <div class="result-diff">
    <div v-if="props.available===false" class="empty diff-empty">
      <GitCompare/>
      <p>{{props.message||'此任務目前無法顯示差異。'}}</p>
    </div>
    <div v-else-if="!props.files.length" class="empty diff-empty">
      <FileStack/>
      <p>目前沒有已變更的檔案。</p>
    </div>
    <template v-else>
      <nav class="diff-file-nav" aria-label="已變更的檔案">
        <button
          v-for="file in props.files" :key="file.path" type="button"
          class="diff-file-item" :class="[statusMeta(file.status).tone,{selected:selectedPath===file.path}]"
          :title="file.oldPath?`${file.oldPath} → ${file.path}`:file.path"
          @click="select(file)"
        >
          <component :is="statusMeta(file.status).icon" :size="16"/>
          <span class="diff-file-name">{{file.path.split('/').pop()}}</span>
        </button>
      </nav>
      <div class="diff-content">
        <template v-if="selectedFile">
          <div class="diff-content-head">
            <span class="badge" :class="statusMeta(selectedFile.status).tone">{{statusMeta(selectedFile.status).label}}</span>
            <span class="diff-content-path">{{selectedFile.oldPath?`${selectedFile.oldPath} → ${selectedFile.path}`:selectedFile.path}}</span>
          </div>
          <div v-if="diffLoading" class="diff-state"><LoaderCircle class="spin" :size="18"/>載入差異內容中…</div>
          <div v-else-if="diffError" class="diff-state error"><AlertCircle :size="18"/>{{diffError}}</div>
          <div v-else-if="!diffAvailable" class="diff-state">{{diffMessage}}</div>
          <div v-else-if="!diffLines.length" class="diff-state">此檔案沒有可顯示的差異內容。</div>
          <div v-else class="diff-lines">
            <div v-for="(line,i) in diffLines" :key="i" class="diff-line" :class="line.type">
              <span class="diff-gutter old">{{line.oldNo??''}}</span>
              <span class="diff-gutter new">{{line.newNo??''}}</span>
              <span class="diff-marker">{{line.type==='add'?'+':line.type==='del'?'-':''}}</span>
              <span class="diff-text">{{line.text}}</span>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.result-diff{display:grid;grid-template-columns:minmax(180px,1fr) minmax(0,3fr);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);box-shadow:var(--shadow-card);overflow:hidden;min-height:360px}
.diff-empty{grid-column:1/-1;min-height:280px}
.diff-file-nav{border-right:1px solid var(--line);overflow:auto;max-height:640px;padding:8px;display:grid;gap:2px;align-content:start;background:#fafbfc}
.diff-file-item{display:flex;align-items:center;gap:9px;padding:9px 10px;border:0;border-radius:9px;background:none;text-align:left;font-size:.8125rem;color:#5b5b60;min-width:0;transition:background .16s var(--ease-soft),color .16s var(--ease-soft)}
.diff-file-item:hover{background:#eef0f2}
.diff-file-item.selected{background:var(--surface);color:var(--ink);box-shadow:0 1px 3px #00000014;font-weight:600}
.diff-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.diff-file-item svg{flex-shrink:0}
.diff-file-item.added svg{color:#268673}
.diff-file-item.deleted svg{color:#b64c4f}
.diff-file-item.modified svg{color:#a67a2c}
.diff-file-item.renamed svg{color:#5b8bd0}
.diff-content{min-width:0;display:flex;flex-direction:column}
.diff-content-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);font-size:.8125rem}
.diff-content-path{overflow-wrap:anywhere;color:var(--ink);font-weight:500}
.badge.added{color:#268673;background:#e6f5ee}
.badge.deleted{color:#b64c4f;background:#ffeded}
.badge.modified{color:#a67a2c;background:#fff5df}
.badge.renamed{color:#3a5fa0;background:#eaf1fe}
.diff-state{display:flex;align-items:center;gap:9px;padding:24px 18px;color:var(--muted);font-size:.875rem}
.diff-state.error{color:#b53e42}
.diff-lines{overflow:auto;max-height:640px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8125rem;line-height:1.65}
.diff-line{display:grid;grid-template-columns:44px 44px 16px minmax(0,1fr);align-items:baseline;padding:0 8px;white-space:pre-wrap;overflow-wrap:anywhere}
.diff-gutter{color:#a8b0ba;text-align:right;padding-right:8px;user-select:none;font-size:.75rem}
.diff-marker{text-align:center;user-select:none;color:#a8b0ba}
.diff-line.add{background:#e9f7ef}
.diff-line.add .diff-marker,.diff-line.add .diff-text{color:#1a7a4c}
.diff-line.del{background:#fdeeee}
.diff-line.del .diff-marker,.diff-line.del .diff-text{color:#b0393c}
.diff-line.context .diff-text{color:#3f3f45}
.diff-line.hunk{background:#f1f4fa;color:#5b6b85;padding-top:4px;padding-bottom:4px;margin-top:2px}
.diff-line.hunk .diff-text{color:#5b6b85;font-weight:600}
.diff-line.meta .diff-text,.diff-line.binary .diff-text{color:var(--muted);font-style:italic}
@media(max-width:850px){.result-diff{grid-template-columns:1fr}.diff-file-nav{border-right:0;border-bottom:1px solid var(--line);max-height:220px}}
</style>
