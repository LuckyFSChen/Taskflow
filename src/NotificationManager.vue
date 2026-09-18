<script setup lang="ts">
import {ref,computed,onMounted,onUnmounted,watch} from 'vue';
import {MessageSquare,RefreshCw} from 'lucide-vue-next';
import {api,useTaskStore} from './store';
type Row={source:'outbox'|'service';id:string;member:string;recipient:string;lineHint:string;message:string;state:string;created:number|null;sentAt:number|null;attempts:number;nextTry:number;error:string|null;cancelledAt:number|null;cancelledByName:string;cancelReason:string|null};
const store=useTaskStore(),rows=ref<Row[]>([]),counts=ref<Record<string,number>>({}),total=ref(0),page=ref(1),state=ref('unsent'),source=ref('all'),search=ref(''),query=ref('');
const loading=ref(false),busy=ref(false),error=ref(''),notice=ref(''),selected=ref<string[]>([]),confirmation=ref<{action:'cancel'|'retry';rows:Row[]}|null>(null);
const names:Record<string,string>={pending:'等待傳送',failed:'傳送失敗',sending:'傳送中',processing:'處理指令中',sent:'已送出',cancelled:'已取消'};
const key=(r:Row)=>r.source+':'+r.id;
const actionable=(r:Row)=>['pending','failed'].includes(r.state);
const chosen=computed(()=>rows.value.filter(r=>selected.value.includes(key(r))&&actionable(r)));
const pages=computed(()=>Math.max(1,Math.ceil(total.value/20)));
const pending=computed(()=>['pending','failed','sending','processing'].reduce((n,s)=>n+(counts.value[s]||0),0));
const time=(value:number|null)=>value?new Date(value).toLocaleString('zh-TW'):'舊紀錄未保存';
let timer:ReturnType<typeof setInterval>,generation=0;
async function refresh(){
  const version=++generation;loading.value=true;
  try{
    const params=new URLSearchParams({state:state.value,source:source.value,search:query.value,page:String(page.value)});
    const data=await api('/admin/notifications?'+params);
    if(version!==generation)return;
    if(page.value>1&&page.value>Math.max(1,Math.ceil(data.total/20))){page.value=Math.max(1,Math.ceil(data.total/20));return;}
    rows.value=data.rows;total.value=data.total;counts.value=data.counts;error.value='';
    selected.value=selected.value.filter(k=>rows.value.some(r=>key(r)===k&&actionable(r)));
  }catch(e:any){if(version===generation)error.value=e.message;}finally{if(version===generation)loading.value=false;}
}
function ask(action:'cancel'|'retry',items:Row[]){if(items.length)confirmation.value={action,rows:[...items]};}
async function apply(){
  const request=confirmation.value;if(!request||busy.value)return;busy.value=true;error.value='';notice.value='';
  try{
    const result=await api('/admin/notifications/action',{action:request.action,confirm:true,items:request.rows.map(({source,id})=>({source,id}))});
    notice.value=`${request.action==='cancel'?'已取消':'已排入重試'} ${result.changed.length} 則。`+(result.skipped.length?`未變更 ${result.skipped.length} 則：${[...new Set(result.skipped.map((r:any)=>r.reason))].join('；')}`:'');
    confirmation.value=null;selected.value=[];await refresh();await store.refresh();
  }catch(e:any){error.value=e.message;}finally{busy.value=false;}
}
function selectPage(event:Event){selected.value=(event.target as HTMLInputElement).checked?rows.value.filter(actionable).map(key):[];}
watch([state,source,query],()=>{selected.value=[];if(page.value!==1)page.value=1;else void refresh();});
watch(page,()=>{selected.value=[];void refresh();});
onMounted(()=>{void refresh();timer=setInterval(()=>{if(!busy.value&&!loading.value&&!confirmation.value)void refresh();},10000);});
onUnmounted(()=>{++generation;clearInterval(timer);});
</script>

<template>
<section class="panel settings-card wide notification-manager">
  <div class="section-heading"><h2><MessageSquare :size="20"/>雲端收件服務・通知紀錄</h2><button class="secondary" :disabled="loading||busy" @click="refresh"><RefreshCw :size="15"/>重新整理</button></div>
  <p>管理經由收件服務送往 LINE 的通知與指令回覆。取消待送會停止後續傳送並保留紀錄，不會取消任務或撤回已送訊息。</p>
  <div class="notification-counts"><span>待送 <strong>{{pending}}</strong></span><span>失敗 <strong>{{counts.failed||0}}</strong></span><span>已送出 <strong>{{counts.sent||0}}</strong></span><span>已取消 <strong>{{counts.cancelled||0}}</strong></span></div>
  <div class="notification-filters">
    <label>狀態<select v-model="state" :disabled="busy"><option value="unsent">全部未送出</option><option value="all">全部紀錄</option><option v-for="(label,value) in names" :key="value" :value="value">{{label}}</option></select></label>
    <label>來源<select v-model="source" :disabled="busy"><option value="all">全部來源</option><option value="outbox">一般通知與互動回覆</option><option value="service">服務指令回覆</option></select></label>
    <form @submit.prevent="query=search"><label>搜尋內容或收件人<input v-model="search" maxlength="200" placeholder="例如 idv-web"/></label><button class="secondary" :disabled="busy">搜尋</button></form>
  </div>
  <p class="subtle">已送出表示 LINE API 已接受，不代表手機已讀。推播額度用完時，重試仍可能失敗。</p>
  <div class="notification-bulk"><label><input type="checkbox" :disabled="busy||!rows.some(actionable)" :checked="rows.some(actionable)&&chosen.length===rows.filter(actionable).length" @change="selectPage"/>勾選本頁可操作項目</label><span>已選 {{chosen.length}} 則</span><button class="secondary" :disabled="busy||!chosen.length" @click="ask('cancel',chosen)">取消勾選待送</button><button class="secondary" :disabled="busy||!chosen.some(r=>r.state==='failed')" @click="ask('retry',chosen.filter(r=>r.state==='failed'))">重試勾選失敗</button></div>
  <p v-if="error" class="error-text" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p>
  <p v-if="loading&&!rows.length" role="status">正在讀取通知紀錄…</p><p v-else-if="!rows.length&&!error" class="subtle">沒有符合條件的紀錄。</p>
  <article v-for="row in rows" :key="key(row)" class="notification-row">
    <div class="notification-top"><input v-if="actionable(row)" v-model="selected" type="checkbox" :value="key(row)" :disabled="busy" :aria-label="'勾選 '+row.member+' 的通知'"/><div class="grow"><strong>{{row.member}}</strong><small>{{row.recipient}} · {{row.lineHint}} · {{row.source==='service'?'服務指令':'通知／互動回覆'}}</small></div><span class="badge" :class="row.state==='sent'?'completed':row.state==='failed'?'failed':row.state==='cancelled'?'cancelled':'waiting_input'">{{names[row.state]}}</span></div>
    <details><summary>{{row.message.slice(0,140)||'尚未產生回覆'}}{{row.message.length>140?'…':''}}</summary><p class="prewrap">{{row.message}}</p></details>
    <div class="notification-meta"><span>建立：{{time(row.created)}}</span><span>失敗次數：{{row.attempts}}</span><span v-if="row.state==='sent'">送出：{{time(row.sentAt)}}</span><span v-if="row.state==='cancelled'">取消：{{time(row.cancelledAt)}} · {{row.cancelledByName||'系統'}}</span><span v-if="row.state==='failed'&&row.nextTry">預計重試：{{time(row.nextTry)}}</span></div>
    <p v-if="row.error" class="error-text">{{row.error}}</p><p v-if="row.cancelReason" class="subtle">{{row.cancelReason}}</p>
    <div v-if="actionable(row)" class="notification-actions"><button class="secondary" :disabled="busy" @click="ask('cancel',[row])">取消待送</button><button v-if="row.state==='failed'" class="secondary" :disabled="busy" @click="ask('retry',[row])">立即排入重試</button></div>
    <p v-else-if="row.state==='sending'" class="subtle">已開始傳送，不能撤回；請稍後重新整理結果。</p>
  </article>
  <div class="notification-pagination"><button class="secondary" :disabled="busy||page<=1" @click="page--">上一頁</button><span>第 {{page}} / {{pages}} 頁 · {{total}} 則</span><button class="secondary" :disabled="busy||page>=pages" @click="page++">下一頁</button></div>
  <Teleport to="body"><div v-if="confirmation" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="notification-confirm-title"><h2 id="notification-confirm-title">{{confirmation.action==='cancel'?'取消待送':'重試失敗'}} {{confirmation.rows.length}} 則通知？</h2><p>{{confirmation.action==='cancel'?'取消後不再自動傳送，內容會保留在已取消紀錄。已進入傳送中的項目不會取消。':'重新排入發送佇列，成功與否仍取決於 LINE 額度及連線；不會重跑原本任務或服務指令。'}}</p><ul class="notification-confirm-list"><li v-for="row in confirmation.rows" :key="key(row)">{{row.member}}：{{row.message.slice(0,160)}}</li></ul><p v-if="error" class="error-text" role="alert">{{error}}</p><div class="modal-actions"><button class="secondary" :disabled="busy" @click="confirmation=null">返回</button><button class="primary" :disabled="busy" @click="apply">{{busy?'處理中…':'確認'+(confirmation.action==='cancel'?'取消待送':'重試')}}</button></div></section></div></Teleport>
</section>
</template>

<style scoped>
.notification-manager{min-width:0}.notification-counts{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}.notification-counts strong{margin-left:8px;font-size:22px}.notification-filters{display:flex;align-items:end;gap:16px;flex-wrap:wrap}.notification-filters label{margin:0;min-width:160px}.notification-filters form{display:flex;align-items:end;gap:8px;flex:1}.notification-filters form label{flex:1}.notification-bulk,.notification-actions,.notification-pagination{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}.notification-bulk label{display:flex;align-items:center;gap:8px;margin:0}.notification-manager input[type=checkbox]{width:18px;min-width:18px;height:18px}.notification-row{padding:20px 0;border-top:1px solid #e5e7eb}.notification-top{display:flex;align-items:center;gap:12px}.notification-top small{display:block;margin-top:5px;color:#64748b}.notification-row details{margin:12px 0;overflow-wrap:anywhere}.notification-row summary{cursor:pointer;white-space:pre-wrap}.notification-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#64748b}.notification-pagination{justify-content:center}.notification-confirm-list{max-height:240px;overflow:auto;overflow-wrap:anywhere}.notification-confirm-list li{margin:10px 0}.prewrap{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:650px){.notification-filters{align-items:stretch}.notification-filters>label,.notification-filters form{width:100%}.notification-top{align-items:start}.notification-counts{gap:14px}}
</style>
