export function validMessages(messages){
  if(!Array.isArray(messages)||!messages.length||messages.length>5)return false;
  return messages.every(m=>{
    if(m?.type!=='text'||typeof m.text!=='string'||!m.text.length||m.text.length>4900)return false;
    if(m.quickReply===undefined)return true;
    const items=m.quickReply?.items;if(!Array.isArray(items)||!items.length||items.length>13)return false;
    return items.every(item=>{const a=item?.action;if(item.type!=='action'||!a||typeof a.label!=='string'||!a.label.length||a.label.length>20)return false;
      if(a.type==='postback')return typeof a.data==='string'&&a.data.startsWith('tf:')&&a.data.length<=300&&(a.displayText===undefined||(typeof a.displayText==='string'&&a.displayText.length<=300));
      if(a.type==='uri'){try{return new URL(a.uri).protocol==='https:';}catch{return false;}}
      return false;
    });
  });
}

export async function installMenu(request,env){
  const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  if(!env.LINE_CHANNEL_ACCESS_TOKEN)return json(409,{error:'LINE access token not configured'});
  const input=await request.json();if(typeof input.imageBase64!=='string'||input.imageBase64.length>1400000)return json(400,{error:'invalid menu image'});
  let bytes;try{bytes=Uint8Array.from(atob(input.imageBase64),c=>c.charCodeAt(0));}catch{return json(400,{error:'invalid image encoding'});}
  if(bytes.length>1024*1024||bytes[0]!==137||bytes[1]!==80||bytes[2]!==78||bytes[3]!==71)return json(400,{error:'PNG required, max 1MB'});
  const headers={Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`};
  async function call(path,options={},dataHost=false){const r=await fetch(`https://${dataHost?'api-data':'api'}.line.me/v2/bot${path}`,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(15000)});return r;}
  const listResponse=await call('/richmenu/list');if(!listResponse.ok)return json(502,{error:'LINE menu list failed',upstreamStatus:listResponse.status});
  const menus=(await listResponse.json()).richmenus||[];
  const name='TaskFlow Quick Actions v1';let menu=menus.find(m=>m.name===name);
  const current=await call('/user/all/richmenu');
  if(current.ok){const old=await current.json();if(old.richMenuId!==menu?.richMenuId&&!menus.find(m=>m.richMenuId===old.richMenuId)?.name?.startsWith('TaskFlow Quick Actions'))return json(409,{error:'An unrelated default rich menu already exists; it was not replaced'});}
  else if(current.status!==404)return json(502,{error:'Cannot check existing default menu',upstreamStatus:current.status});
  if(!menu){const items=[['發布任務','tf:new'],['任務進度','tf:status:0'],['待我審核','tf:pending:0'],['工作台','tf:web']];const definition={size:{width:2500,height:843},selected:true,name,chatBarText:'任務快捷選單',areas:items.map(([label,data],i)=>({bounds:{x:i%2*1250,y:i<2?0:421,width:1250,height:i<2?421:422},action:{type:'postback',label,data,displayText:label}}))};
    const created=await call('/richmenu',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(definition)});if(!created.ok)return json(502,{error:'LINE menu creation failed',upstreamStatus:created.status});menu=await created.json();}
  const image=await call(`/richmenu/${menu.richMenuId}/content`,{},true);
  if(image.status===404){const uploaded=await call(`/richmenu/${menu.richMenuId}/content`,{method:'POST',headers:{'Content-Type':'image/png'},body:bytes},true);if(!uploaded.ok)return json(502,{error:'LINE menu image upload failed',upstreamStatus:uploaded.status,menuId:menu.richMenuId});}
  else if(!image.ok)return json(502,{error:'Cannot check menu image',upstreamStatus:image.status});
  const linked=await call(`/user/all/richmenu/${menu.richMenuId}`,{method:'POST'});if(!linked.ok)return json(502,{error:'LINE default menu update failed',upstreamStatus:linked.status});
  const verified=await call('/user/all/richmenu');const state=verified.ok?await verified.json():{};
  if(state.richMenuId!==menu.richMenuId)return json(502,{error:'Default menu verification failed'});
  return json(200,{ok:true,menuId:menu.richMenuId,name,verified:true});
}
