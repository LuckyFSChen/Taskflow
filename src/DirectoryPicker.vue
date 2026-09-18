<script setup lang="ts">
import {ref,computed,onMounted} from 'vue';
import {Folder,ArrowUp,Home,Plus,Search,X,LoaderCircle} from 'lucide-vue-next';
import {api} from './store';
const props=defineProps<{initialPath?:string;suggestedName?:string;title?:string}>();
const emit=defineEmits<{select:[path:string];close:[]}>();
const dialog=ref<HTMLDialogElement>(),listing=ref<any>(null),loading=ref(false),error=ref(''),filter=ref(''),address=ref(''),newName=ref(props.suggestedName||''),creating=ref(false);
const folders=computed(()=>listing.value?.folders.filter((f:any)=>f.name.toLowerCase().includes(filter.value.toLowerCase()))||[]);
async function browse(path=''){
  if(loading.value)return;loading.value=true;error.value='';
  try{listing.value=await api('/admin/directories'+(path?'?path='+encodeURIComponent(path):''));address.value=listing.value.path;filter.value='';creating.value=false;}catch(e:any){error.value=e.message;}finally{loading.value=false;}
}
async function create(){if(loading.value||!listing.value)return;loading.value=true;error.value='';try{const result=await api('/admin/directories',{parent:listing.value.path,name:newName.value});loading.value=false;await browse(result.path);}catch(e:any){error.value=e.message;}finally{loading.value=false;}}
onMounted(()=>{dialog.value?.showModal();void browse(props.initialPath);});
</script>
<template>
  <dialog ref="dialog" class="directory-picker" aria-labelledby="directory-title" @cancel.prevent="emit('close')" @click="e=>{if(e.target===dialog)emit('close')}">
    <header><div><h2 id="directory-title">{{title||'選擇專案資料夾'}}</h2><p>選擇現有資料夾，或建立新資料夾存放專案。</p></div><button type="button" class="icon-button" aria-label="關閉資料夾選擇" @click="emit('close')"><X :size="20"/></button></header>
    <div class="folder-toolbar"><button type="button" class="secondary" :disabled="loading||!listing?.parent" @click="browse(listing.parent)"><ArrowUp :size="16"/>上一層</button><button type="button" class="secondary" :disabled="loading" @click="browse(listing?.defaultRoot||'')"><Home :size="16"/>預設位置</button><select aria-label="磁碟機" :disabled="loading" :value="listing?.drives.find((d:string)=>listing.path.startsWith(d))||''" @change="browse(($event.target as HTMLSelectElement).value)"><option value="" disabled>選擇磁碟機</option><option v-for="drive in listing?.drives" :key="drive" :value="drive">{{drive}}</option></select></div>
    <form class="folder-address" @submit.prevent="browse(address)"><label>目前位置<input v-model="address" aria-label="目前資料夾路徑" :disabled="loading" placeholder="載入預設位置…"></label><button class="secondary" :disabled="loading">前往</button></form>
    <div class="folder-search"><Search :size="16"/><input v-model="filter" aria-label="搜尋資料夾" placeholder="搜尋此位置的資料夾"><button type="button" class="secondary" :disabled="loading||!listing" @click="creating=!creating"><Plus :size="16"/>新增資料夾</button></div>
    <form v-if="creating" class="folder-create" @submit.prevent="create"><label>新資料夾名稱<input v-model="newName" maxlength="80" required placeholder="例如：我的網站"></label><button class="primary" :disabled="loading">建立並進入</button></form>
    <p v-if="error" class="folder-error" role="alert">{{error}}</p>
    <div class="folder-list" :aria-busy="loading"><p v-if="loading"><LoaderCircle class="spin" :size="18"/> 正在讀取資料夾…</p><template v-else><button v-for="folder in folders" :key="folder.path" type="button" @click="browse(folder.path)"><Folder :size="20"/><span>{{folder.name}}</span><small>進入 →</small></button><p v-if="listing&&!folders.length">{{filter?'找不到符合的資料夾':'這個位置尚無子資料夾，可直接選取或新增資料夾。'}}</p></template></div>
    <small v-if="listing?.truncated">僅顯示前 1,000 個資料夾，可在上方路徑欄直接前往其他位置。</small>
    <footer><div><small>將使用此資料夾</small><strong>{{listing?.path||'尚未選取'}}</strong><small v-if="listing&&!listing.selectable">{{listing.reason}}</small></div><button type="button" class="secondary" @click="emit('close')">取消</button><button type="button" class="primary" :disabled="loading||!!error||!listing?.selectable" @click="emit('select',listing.path)">選取此資料夾</button></footer>
  </dialog>
</template>
<style scoped>
.directory-picker{border:1px solid #dce4e9;border-radius:16px;padding:24px;width:min(720px,calc(100vw - 32px));max-height:90vh;overflow:auto;color:#263947;box-shadow:0 24px 80px #10203040}.directory-picker::backdrop{background:#14263675}.directory-picker header{display:flex;justify-content:space-between;gap:15px}.directory-picker h2{margin:0;font-size:1.25rem}.directory-picker p{font-size:.85rem;color:#738492}.folder-toolbar,.folder-address,.folder-search,.folder-create{display:flex;align-items:end;gap:10px;margin:15px 0}.folder-toolbar select{width:auto}.folder-address label,.folder-create label{flex:1;min-width:0;font-size:.8rem}.folder-search{align-items:center}.folder-search input{flex:1;min-width:0;margin:0}.folder-list{min-height:160px;max-height:290px;overflow:auto;border:1px solid #e3e9ee;border-radius:9px;padding:6px}.folder-list>button{width:100%;display:flex;align-items:center;gap:12px;border:0;background:white;padding:12px;text-align:left;border-radius:6px}.folder-list>button:hover,.folder-list>button:focus-visible{background:#edf5f1}.folder-list span{flex:1;overflow-wrap:anywhere}.folder-list p{padding:20px}.folder-error{color:#ad3030!important}.directory-picker footer{display:flex;gap:10px;align-items:center;border-top:1px solid #e3e9ee;margin-top:20px;padding-top:18px}.directory-picker footer>div{flex:1;min-width:0}.directory-picker footer strong,.directory-picker footer small{display:block;overflow-wrap:anywhere;font-size:.8rem}.directory-picker footer strong{margin:5px 0}.secondary,.primary{white-space:nowrap}@media(max-width:600px){.directory-picker{padding:16px}.folder-toolbar,.folder-search,.folder-create,.directory-picker footer{flex-wrap:wrap}.directory-picker footer>div{flex-basis:100%}.folder-search input{width:75%}.folder-list{max-height:220px}}
</style>
