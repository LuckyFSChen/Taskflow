<script setup lang="ts">
import {ref,onMounted,onUnmounted} from 'vue';
import {MessageSquare,Trash2} from 'lucide-vue-next';
import {api,useTaskStore} from './store';
const loaded=ref(false),syncError=ref('');
const store=useTaskStore(),links=ref<any[]>([]),label=ref(''),drafts=ref<Record<string,string>>({}),command=ref(''),expires=ref(0),busy=ref(false),message=ref(''),removing=ref<any>(null);
let timer:ReturnType<typeof setInterval>;
async function refresh(){try{const data=await api('/account/line-links');if(!Array.isArray(data.links))throw new Error('LINE 連結資料暫時無法讀取，請稍後重試。');links.value=data.links;expires.value=data.pendingExpires||0;if(!expires.value)command.value='';for(const link of data.links)if(drafts.value[link.id]===undefined)drafts.value[link.id]=link.label;loaded.value=true;syncError.value='';}catch(e:any){syncError.value=e.message;throw e;}}

async function run(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;message.value='';try{await fn();await refresh();}catch(e:any){message.value=e.message;}finally{busy.value=false;}}
async function generate(){await run(async()=>{const result=await api('/account/line-link',{label:label.value||'LINE'});command.value=result.command;expires.value=result.expiresAt;label.value='';});}
async function update(link:any,body:any){await run(async()=>{await api(`/account/line-links/${link.id}/update`,body);message.value='連結設定已儲存';});}
async function unlink(){await run(async()=>{await api(`/account/line-links/${removing.value.id}/remove`,{confirm:true});removing.value=null;message.value='已解除連結，其他 LINE 仍可繼續使用';await store.refresh();});}
onMounted(()=>{void refresh().catch(()=>{});timer=setInterval(()=>{if(!busy.value)void refresh().catch(()=>{});},3000);});onUnmounted(()=>clearInterval(timer));
</script>
<template>
<section class="panel settings-card"><h2><MessageSquare :size="20"/>LINE 連結管理</h2><p>一個 TaskFlow 帳號可綁定多個 LINE。各 LINE 的操作對話分開保存，共用此帳號的任務與權限。</p>
<div v-for="link in links" :key="link.id" class="line-binding"><form @submit.prevent="update(link,{label:drafts[link.id]})"><label>連結名稱<input v-model="drafts[link.id]" maxlength="80" required :disabled="busy"/></label><button class="secondary" :disabled="busy||!drafts[link.id]?.trim()||drafts[link.id]===link.label">儲存名稱</button></form><small>{{link.lineHint}} · 綁定於 {{new Date(link.created).toLocaleString()}}</small><small>最近使用：{{link.last_seen?new Date(link.last_seen).toLocaleString():'尚無紀錄'}}</small><label class="notify-option"><input type="checkbox" :checked="link.notifications" :disabled="busy" @change="update(link,{notifications:($event.target as HTMLInputElement).checked})"/>接收任務通知</label><button class="secondary" :disabled="busy" @click="removing=link"><Trash2 :size="14"/>解除此連結</button></div>
<p v-if="!loaded&&!syncError" class="subtle" role="status">正在讀取 LINE 連結…</p><div v-if="syncError" role="alert"><p class="error-text">{{syncError}}</p><button class="secondary" :disabled="busy" @click="run(refresh)">重新讀取連結</button></div><p v-if="loaded&&!syncError&&!links.length" class="subtle">尚未綁定 LINE。</p><form @submit.prevent="generate"><label>新增 LINE 的名稱<input v-model="label" maxlength="80" placeholder="例如：個人 LINE、工作 LINE" :disabled="busy"/></label><button class="secondary" :disabled="busy">{{expires?'重新產生連結碼':'新增 LINE 連結'}}</button></form><p class="subtle">在要綁定的 LINE 帳號中私訊 Bot，貼上以下指令。新增不會取代既有連結；重新產生會使上一組未使用的連結碼失效。</p><code v-if="command" class="code-block">{{command}}</code><small v-if="expires">有效至 {{new Date(expires).toLocaleTimeString()}}，請只交給你要授權的 LINE 帳號。</small><button v-if="expires" class="secondary" :disabled="busy" @click="run(async()=>{await api('/account/line-link/cancel',{});command='';})">取消未使用的連結碼</button><p role="status">{{message}}</p><div class="connection-detail">收件匣：{{store.integrations.lineConfigured?'已設定':'尚未設定'}}<br>待發通知：{{store.integrations.pendingNotifications}}<span v-if="store.integrations.error" class="error-text">{{store.integrations.error}}</span></div>
<Teleport to="body"><div v-if="removing" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="unlink-line-title"><h2 id="unlink-line-title">解除「{{removing.label}}」？</h2><p>此 LINE 將無法操作你的 TaskFlow 帳號，尚未發送的訊息會取消。其他 LINE 綁定與既有任務會保留。</p><p role="alert">{{message}}</p><div class="modal-actions"><button class="secondary" :disabled="busy" @click="removing=null">取消</button><button class="primary" :disabled="busy" @click="unlink">確認解除</button></div></section></div></Teleport>
</section>
</template>
<style scoped>
.line-binding{padding:16px 0;border-bottom:1px solid #e5e7eb}.line-binding form{display:flex;gap:8px;align-items:end}.line-binding form label{flex:1;margin:0}.line-binding small{display:block;margin:8px 0;overflow-wrap:anywhere}.notify-option{display:flex;gap:8px;align-items:center;margin:12px 0}.notify-option input{width:auto}.secondary{margin:6px 0}.code-block{overflow-wrap:anywhere;white-space:pre-wrap}
</style>
