<script setup lang="ts">
defineProps<{request?:{summary:string;evidence:string[]};skips?:{id:string;summary:string}[];busy:boolean}>();
defineEmits<{decide:[decision:'skip'|'wait']}>();
</script>
<template>
  <section v-if="request" class="questions">
    <h3>驗證工具存取失敗：是否跳過？</h3>
    <p class="prewrap">{{request.summary}}</p>
    <details><summary>查看驗證證據</summary><p v-for="(item,i) in request.evidence" :key="i">{{item}}</p></details>
    <p>只跳過工具無法存取的檢查，保留「未驗證」紀錄；其他驗證與功能錯誤仍需處理。</p>
    <div class="actions"><button class="primary" :disabled="busy" @click="$emit('decide','skip')">跳過受限驗證並繼續</button><button class="secondary" :disabled="busy" @click="$emit('decide','wait')">不跳過，等待處理</button></div>
  </section>
  <section v-if="skips?.length" class="questions"><h3>有驗證項目經同意跳過（未驗證）</h3><details v-for="item in skips" :key="item.id"><summary>查看跳過原因與範圍</summary><p class="prewrap">{{item.summary}}</p></details></section>
</template>
<style scoped>.actions{display:flex;gap:12px;flex-wrap:wrap}</style>
