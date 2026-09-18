<script setup lang="ts">
import {ref} from 'vue';
import {Trash2,X} from 'lucide-vue-next';
import {api,useTaskStore} from './store';
const props=defineProps<{project:any}>();
const emit=defineEmits<{removed:[projectId:string,pendingCleanup:string[]]}>();
const store=useTaskStore(),plan=ref<any>(null),confirmCode=ref(''),busy=ref(false),error=ref(''),cleanup=ref<string[]>([]);
async function inspect(){error.value='';busy.value=true;try{plan.value=await api(`/admin/projects/${props.project.id}/removal`);confirmCode.value='';}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
async function remove(){if(busy.value||confirmCode.value!==plan.value?.project.code)return;busy.value=true;error.value='';try{
  const result=await api(`/admin/projects/${props.project.id}/remove`,{confirmCode:confirmCode.value,fingerprint:plan.value.fingerprint});
  cleanup.value=result.pendingCleanup||[];
  emit('removed',props.project.id,cleanup.value);plan.value=null;await store.refresh();
}catch(e:any){error.value=e.message;}finally{busy.value=false;}}
function close(){if(busy.value)return;if(cleanup.value.length){emit('removed',props.project.id,cleanup.value);void store.refresh();}plan.value=null;}
</script>
<template>
  <div class="project-remove"><button class="secondary delete-button" :disabled="busy" @click="inspect"><Trash2 :size="15"/>移除專案</button><small v-if="error&&!plan" role="alert">{{error}}</small></div>
  <Teleport to="body"><div v-if="plan" class="modal-backdrop" @click.self="close"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="remove-project-title"><header><h2 id="remove-project-title">移除「{{plan.project.name}}」</h2><button class="icon-button" :disabled="busy" title="關閉" @click="close"><X/></button></header>
    <template v-if="!cleanup.length"><p class="error-text">此操作會永久刪除磁碟檔案，不會放入資源回收筒。</p><p>同時移除 {{plan.taskCount}} 個任務、{{plan.threadCount}} 筆角色工作紀錄與成員的專案授權。原始資料夾內的所有檔案（包含手動加入的檔案）都會刪除。</p>
    <ul class="deletion-paths"><li v-for="item in plan.paths" :key="item.path"><strong>{{item.kind}}</strong><code>{{item.path}}</code><small v-if="!item.exists">資料夾已不存在，僅清理相關紀錄。</small></li></ul>
    <form @submit.prevent="remove"><label>輸入專案代號「{{plan.project.code}}」確認刪除<input v-model="confirmCode" :disabled="busy" autocomplete="off" required autofocus/></label><p v-if="error" class="error-text" role="alert">{{error}}</p><div class="modal-actions"><button type="button" class="secondary" :disabled="busy" @click="close">取消</button><button class="primary delete-confirm" :disabled="busy||confirmCode!==plan.project.code">{{busy?'正在移除…':'永久移除專案及檔案'}}</button></div></form></template>
    <template v-else><p class="error-text" role="alert">{{error}}</p><ul class="deletion-paths"><li v-for="path in cleanup" :key="path"><code>{{path}}</code></li></ul><button class="secondary" @click="close">關閉</button></template>
  </section></div></Teleport>
</template>
<style scoped>
.project-remove{margin-left:auto}.delete-button{color:#b42318!important}.project-remove small{display:block;color:#b42318;max-width:350px;margin-top:8px}.deletion-paths{max-height:260px;overflow:auto;padding-left:22px}.deletion-paths li{margin:12px 0}.deletion-paths code{display:block;overflow-wrap:anywhere;white-space:normal;margin-top:4px}.delete-confirm{background:#b42318!important}.modal{max-height:90vh;overflow:auto}
</style>
