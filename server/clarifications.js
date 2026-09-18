// Keep answers paired with the questions they addressed, including older task versions.
export function clarificationHistory(task,threads=[]) {
  if(Array.isArray(task.clarifications))return task.clarifications;
  const answers=task.description.split('\n\n補充需求：').slice(1);
  return answers.map((answer,index)=>{
    const version=index+1;
    const prior=threads.filter(th=>th.version===version&&th.result?.questions?.length).at(-1);
    return {version,questions:prior?.result.questions||[],answer,source:'legacy'};
  });
}
export function recordClarification(task,threads,questions,answer){
  task.clarifications=[...clarificationHistory(task,threads),{version:task.planVersion,questions:[...questions],answer:answer.trim(),at:new Date().toISOString()}];
}
export function clarificationPrompt(task,threads){
  return `\n使用者歷次問答（依時間順序；簡短「是／允許／不用」只適用於配對問題，不代表其他操作的概括授權）：${JSON.stringify(clarificationHistory(task,threads))}
提問規則：先查閱需求、歷次問答及已核准計畫。已回答的事項必須沿用，不得換句話重問。只有會阻止下一步且尚未決定的範圍、授權或必要輸入才列入 questions；一次集中提出。範圍內的一般技術選擇、可逆修正、已同意的測試方式直接處理。
執行中需要核准具體操作時，questions 使用「是否核准……？」並完整列出操作、版本與影響範圍，讓使用者直接選擇核准或不核准。需要文字資訊的問題不要包裝為核准。收到核准後接續原步驟與已有成果，不重新規劃；收到不核准不得執行被拒操作或擅自採用替代方案。
環境限制（例如裝置模擬無法等同真實 Safari）應寫在 summary 與驗證報告，不要反覆要求同意同一限制。不得因此虛報驗收通過或放寬尚未獲同意的驗收條件。
工具拒絕不是缺少使用者意願：若使用者已同意而工具仍拒絕，回報工具名稱、被拒的操作與可行處理方式，不得再次只問「是否允許」。不得繞過工具權限。規劃時先安排可完成的修正，再做受限驗證，不要讓非必要的前置視覺檢查阻塞全部修正。
重新規劃時保留工作副本既有成果，先檢查已完成部分，不要重新從空白開始。`;
}
