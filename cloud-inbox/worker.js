// TaskFlow 雲端收件匣 — Cloudflare Worker + D1
//
// 這個 Worker 是獨立於本機 TaskFlow 服務之外的收件層：
//   1. 接收並驗簽 LINE webhook，將事件原封不動存進 D1（不解讀、不執行內容）。
//   2. 讓本機 runner 以 bearer token 拉取尚未確認的事件、逐筆確認（ack）。
//   3. 讓本機 runner 以 bearer token 委託本 Worker 呼叫 LINE push API 發送訊息。
//
// 設計前提（對應 docs/SPEC.md「部署與邊界」）：只有一台本機 runner 會拉取事件，
// 事件去重在本機交易內完成，因此這裡不需要租約（leasing）機制，
// 只需保證「未確認事件不會被跳過、確認後不重覆派送」。

import {validMessages,installMenu} from './line-menu.js';
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_LINE_TEXT_LENGTH = 4900;
const PULL_LIMIT = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 常數時間字串比較，避免簽章／token 比對透過提早短路洩漏時間資訊。
export function constantTimeEqual(a, b) {
  const ea = textEncoder.encode(String(a ?? ''));
  const eb = textEncoder.encode(String(b ?? ''));
  const len = Math.max(ea.length, eb.length, 1);
  let diff = ea.length === eb.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const x = i < ea.length ? ea[i] : 0;
    const y = i < eb.length ? eb[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
}

export async function computeLineSignature(secret, bodyBuffer) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, bodyBuffer);
  return arrayBufferToBase64(mac);
}

export async function verifyLineSignature(secret, bodyBuffer, signatureHeader) {
  if (!secret || !signatureHeader) return false;
  try {
    const signature = Uint8Array.from(atob(signatureHeader), char => char.charCodeAt(0));
    if (signature.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, signature, bodyBuffer);
  } catch { return false; }
}

export function extractBearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function isAuthorized(request, expectedToken) {
  if (!expectedToken) return false;
  const token = extractBearerToken(request);
  if (!token) return false;
  return constantTimeEqual(token, expectedToken);
}

export function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function isValidLineUserId(value) {
  return typeof value === 'string' && LINE_USER_ID_RE.test(value);
}

// POST /line/webhook
export async function handleWebhook(request, env) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: 'payload too large' });
  }

  const bodyBuffer = await request.arrayBuffer();
  if (bodyBuffer.byteLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: 'payload too large' });
  }
  if (bodyBuffer.byteLength === 0) {
    return jsonResponse(400, { error: 'empty body' });
  }

  if (!env.LINE_CHANNEL_SECRET) {
    return jsonResponse(500, { error: 'server not configured' });
  }

  const signatureHeader = request.headers.get('x-line-signature');
  const validSignature = await verifyLineSignature(env.LINE_CHANNEL_SECRET, bodyBuffer, signatureHeader);
  if (!validSignature) {
    return jsonResponse(401, { error: 'invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(bodyBuffer));
  } catch {
    return jsonResponse(400, { error: 'malformed json' });
  }

  if (!payload || !Array.isArray(payload.events)) {
    return jsonResponse(400, { error: 'malformed payload' });
  }

  if (payload.events.length === 0) {
    return jsonResponse(200, { ok: true, stored: 0 });
  }

  const receivedAt = new Date().toISOString();
  const statements = [];
  for (const event of payload.events) {
    // 注意：event 內容（例如使用者傳來的文字）只會原封不動存成 JSON，
    // 絕不會被當成指令解讀或執行——那是本機 server/line.js 收到已入庫事件後才做的事。
    const eventId = event && event.webhookEventId;
    if (typeof eventId !== 'string' || eventId.length === 0) {
      return jsonResponse(400, { error: 'event missing webhookEventId' });
    }
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO events (webhook_event_id, raw_json, received_at) VALUES (?, ?, ?)'
      ).bind(eventId, JSON.stringify(event), receivedAt)
    );
  }

  // 用 batch 確保「全部落地才回 200」；任何一筆失敗都不回應成功。
  await env.DB.batch(statements);

  return jsonResponse(200, { ok: true, stored: statements.length });
}

// POST /runner/pull
export async function handlePull(request, env) {
  if (!isAuthorized(request, env.INBOX_TOKEN)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  const { results } = await env.DB.prepare(
    `SELECT webhook_event_id, raw_json FROM events
     WHERE acknowledged_at IS NULL
     ORDER BY seq ASC
     LIMIT ${PULL_LIMIT}`
  ).all();

  const events = (results || []).map(row => JSON.parse(row.raw_json));
  return jsonResponse(200, { events });
}

// POST /runner/ack
export async function handleAck(request, env) {
  if (!isAuthorized(request, env.INBOX_TOKEN)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'malformed json' });
  }

  if (!body || typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse(400, { error: 'missing id' });
  }

  // 冪等：不論這筆事件先前是否已確認、甚至根本不存在，都回 {ok:true}。
  // 確認後不刪除資料列——保留紀錄由 README 說明的手動清理程序負責。
  await env.DB.prepare(
    'UPDATE events SET acknowledged_at = ? WHERE webhook_event_id = ? AND acknowledged_at IS NULL'
  ).bind(new Date().toISOString(), body.id).run();

  return jsonResponse(200, { ok: true });
}

// POST /runner/notify
export async function handleNotify(request, env) {
  if (!isAuthorized(request, env.INBOX_TOKEN)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'malformed json' });
  }

  if (!body) return jsonResponse(400, { error: 'malformed json' });
  const { to, text, retryKey } = body;

  if (!isValidLineUserId(to)) return jsonResponse(400, { error: 'invalid to' });
  if (!isValidUuid(retryKey)) return jsonResponse(400, { error: 'invalid retryKey' });
  const messages=body.messages??(typeof text==='string'&&text.length?[{type:'text',text:text.slice(0,MAX_LINE_TEXT_LENGTH)}]:null);
  if (!validMessages(messages)) return jsonResponse(400, { error: 'invalid messages' });

  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    return jsonResponse(500, { error: 'server not configured' });
  }

  // Fresh command responses can use the webhook reply token. Offline requests
  // and expired tokens retain the existing, idempotent push delivery path.
  if(body.replyToken!==undefined){
    if(typeof body.replyToken!=='string'||!body.replyToken.length||body.replyToken.length>200)return jsonResponse(400,{error:'invalid replyToken'});
    let reply;
    try{
      reply=await fetch('https://api.line.me/v2/bot/message/reply',{
        method:'POST',headers:{authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,'content-type':'application/json'},
        body:JSON.stringify({replyToken:body.replyToken,messages}),signal:AbortSignal.timeout(15000),
      });
    }catch{return jsonResponse(502,{error:'line reply request failed'});}
    if(reply.ok)return jsonResponse(200,{ok:true});
    // Only an explicitly rejected/expired token permits immediate push fallback.
    if(reply.status!==400)return jsonResponse(502,{error:'line reply rejected',upstreamStatus:reply.status});
  }

  let upstream;
  try {
    upstream = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'content-type': 'application/json',
        'x-line-retry-key': retryKey,
      },
      body: JSON.stringify({ to, messages }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // 絕不把 token 或原始錯誤內容寫進回應或 log。
    return jsonResponse(502, { error: 'line push request failed' });
  }

  if (upstream.ok || upstream.status === 409) {
    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(502, { error: 'line push rejected', upstreamStatus: upstream.status });
}

// GET /health
export function handleHealth() {
  return jsonResponse(200, { ok: true });
}

const KNOWN_ROUTES = new Set(['/health', '/line/webhook', '/runner/pull', '/runner/ack', '/runner/notify','/runner/menu/install','/runner/notification-status']);

export async function router(request, env) {
  const url = new URL(request.url);

  try {
    if(request.method==='GET'&&url.pathname==='/runner/notification-status'){
      if(!isAuthorized(request,env.INBOX_TOKEN))return jsonResponse(401,{error:'unauthorized'});
      if(!env.LINE_CHANNEL_ACCESS_TOKEN)return jsonResponse(500,{error:'server not configured'});
      const headers={authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`};
      const results=await Promise.all(['quota','quota/consumption'].map(async path=>{
        const response=await fetch(`https://api.line.me/v2/bot/message/${path}`,{headers,signal:AbortSignal.timeout(15000)});
        if(!response.ok)return {upstreamStatus:response.status};
        const body=await response.json();
        return path==='quota'?{type:body.type,limit:body.value}:{used:body.totalUsage};
      }));
      return jsonResponse(200,{...results[0],...results[1]});
    }
    if(request.method==='POST'&&url.pathname==='/runner/menu/install'){
      if(!isAuthorized(request,env.INBOX_TOKEN))return jsonResponse(401,{error:'unauthorized'});
      return await installMenu(request,env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return handleHealth();
    }
    if (request.method === 'POST' && url.pathname === '/line/webhook') {
      return await handleWebhook(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/runner/pull') {
      return await handlePull(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/runner/ack') {
      return await handleAck(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/runner/notify') {
      return await handleNotify(request, env);
    }
    if (KNOWN_ROUTES.has(url.pathname)) {
      return jsonResponse(405, { error: 'method not allowed' });
    }
    return jsonResponse(404, { error: 'not found' });
  } catch (err) {
    // 不記錄未經過濾的例外內容，避免上游錯誤夾帶憑證或訊息資料。
    console.error('TaskFlow inbox request failed');
    return jsonResponse(500, { error: 'internal error' });
  }
}

export default {
  fetch: (request, env, ctx) => router(request, env, ctx),
};
