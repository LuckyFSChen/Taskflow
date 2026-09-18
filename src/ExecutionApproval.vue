<script setup lang="ts">
defineProps<{request:{id:string;questions:string[]};busy:boolean}>();
defineEmits<{decide:[decision:'approve'|'reject']}>();
</script>
<template>
  <section class="questions" aria-label="操作核准">
    <h3>需要你核准</h3>
    <p v-for="(question,index) in request.questions" :key="index" class="prewrap">{{question}}</p>
    <p>核准後接續原步驟，保留計畫與已完成成果。不核准則暫停任務。</p>
    <div class="approval-actions">
      <button class="primary" :disabled="busy" @click="$emit('decide','approve')">核准並繼續</button>
      <button class="secondary" :disabled="busy" @click="$emit('decide','reject')">不核准，暫停任務</button>
    </div>
  </section>
</template>
<style scoped>.approval-actions{display:flex;gap:12px;flex-wrap:wrap}</style>
