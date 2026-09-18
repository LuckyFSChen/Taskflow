export async function api(path:string,body?:unknown){
  const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  if(!(response.headers.get('content-type')||'').toLowerCase().includes('application/json'))throw new Error(response.ok?'目前連到的服務版本尚未就緒，請稍後重試或重新整理頁面。':`服務暫時無法回應（${response.status}），請稍後重試。`);
  let data:any;try{data=await response.json();}catch{throw new Error('服務回傳的資料不完整，請稍後重試。');}
  if(!response.ok)throw new Error(data?.error||'服務暫時無法使用');
  return data;
}
