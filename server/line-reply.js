export function lineReplyDelivery(event={},clock=Date.now){
  const now=clock(),timestamp=event.timestamp;
  const valid=typeof event.replyToken==='string'&&event.replyToken.length>0&&event.replyToken.length<=200&&Number.isFinite(timestamp)&&timestamp<=now+60000&&timestamp+55000>now;
  return {replyToken:valid?event.replyToken:null,replyExpires:valid?Math.min(timestamp,now)+55000:0};
}
