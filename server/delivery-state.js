const tables={outbox:'id',service_requests:'event_id'};
export function initDeliveryState(db,table){
  if(!tables[table])throw new Error('Invalid delivery table');
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
  for(const [name,type] of [['created_at','INTEGER'],['sent_at','INTEGER'],['cancelled_at','INTEGER'],['cancelled_by','TEXT'],['cancel_reason','TEXT'],['claimed_at','INTEGER']]){
    if(!columns.includes(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}
export function claimDelivery(db,table,id,now=Date.now()){
  if(!tables[table])throw new Error('Invalid delivery table');
  return db.prepare(`UPDATE ${table} SET claimed_at=? WHERE ${tables[table]}=? AND sent=0 AND cancelled_at IS NULL AND (claimed_at IS NULL OR claimed_at<?)`).run(now,id,now-120000).changes===1;
}
