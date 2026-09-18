// 執行方式： node --test cloud-inbox/worker.test.js
// 這裡用一個極簡的假 D1（in-memory）取代真正的 Cloudflare D1，
// 只實作 worker.js 實際用到的 prepare/bind/run/all/batch 語意，
// 不驗證 wrangler 部署或真正的 D1 綁定行為。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import {
  router,
  constantTimeEqual,
  verifyLineSignature,
  isValidUuid,
  isValidLineUserId,
} from './worker.js';

function createFakeD1() {
  let seq = 0;
  const rows = [];

  function execute(sql, args) {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('INSERT OR IGNORE INTO events')) {
      const [webhookEventId, rawJson, receivedAt] = args;
      if (!rows.some(r => r.webhook_event_id === webhookEventId)) {
        seq += 1;
        rows.push({ seq, webhook_event_id: webhookEventId, raw_json: rawJson, received_at: receivedAt, acknowledged_at: null });
      }
      return { success: true, results: [] };
    }

    if (normalized.startsWith('SELECT webhook_event_id, raw_json FROM events')) {
      const results = rows
        .filter(r => r.acknowledged_at === null)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, 30)
        .map(r => ({ webhook_event_id: r.webhook_event_id, raw_json: r.raw_json }));
      return { success: true, results };
    }

    if (normalized.startsWith('UPDATE events SET acknowledged_at')) {
      const [acknowledgedAt, webhookEventId] = args;
      const row = rows.find(r => r.webhook_event_id === webhookEventId && r.acknowledged_at === null);
      if (row) row.acknowledged_at = acknowledgedAt;
      return { success: true, results: [] };
    }

    throw new Error(`fake D1 收到未支援的語句: ${normalized}`);
  }

  function makeStatement(sql) {
    let boundArgs = [];
    const statement = {
      bind(...args) {
        boundArgs = args;
        return statement;
      },
      async run() {
        return execute(sql, boundArgs);
      },
      async all() {
        return execute(sql, boundArgs);
      },
    };
    return statement;
  }

  return {
    prepare: sql => makeStatement(sql),
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
    _rows: rows,
  };
}

function makeEnv(overrides = {}) {
  return {
    DB: createFakeD1(),
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    INBOX_TOKEN: 'test-inbox-token',
    ...overrides,
  };
}

function signBody(secret, bodyString) {
  return createHmac('sha256', secret).update(bodyString).digest('base64');
}

function webhookRequest(bodyString, { secret = 'test-channel-secret', signature, headers = {} } = {}) {
  const sig = signature !== undefined ? signature : signBody(secret, bodyString);
  return new Request('https://worker.example/line/webhook', {
    method: 'POST',
    headers: { 'x-line-signature': sig, 'content-type': 'application/json', ...headers },
    body: bodyString,
  });
}

function authedRequest(path, body, token = 'test-inbox-token') {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sampleEvent(id) {
  return {
    type: 'message',
    webhookEventId: id,
    timestamp: 1700000000000,
    source: { type: 'user', userId: 'U' + '0'.repeat(32) },
    message: { type: 'text', id: '123', text: 'hello' },
  };
}

test('constantTimeEqual 對相同與不同字串的判斷', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
});

test('verifyLineSignature 驗證正確與錯誤的簽章', async () => {
  const secret = 'my-secret';
  const body = JSON.stringify({ events: [] });
  const buffer = new TextEncoder().encode(body).buffer;
  const validSig = signBody(secret, body);

  assert.equal(await verifyLineSignature(secret, buffer, validSig), true);
  assert.equal(await verifyLineSignature(secret, buffer, 'wrong-signature'), false);
  assert.equal(await verifyLineSignature(secret, buffer, null), false);
});

test('isValidUuid / isValidLineUserId 格式檢查', () => {
  assert.equal(isValidUuid(randomUUID()), true);
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidLineUserId('U' + 'a'.repeat(32)), true);
  assert.equal(isValidLineUserId('U' + 'a'.repeat(31)), false);
  assert.equal(isValidLineUserId('X' + 'a'.repeat(32)), false);
});

test('GET /health 不需要驗證且不含機密', async () => {
  const env = makeEnv();
  const res = await router(new Request('https://worker.example/health'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
});

test('未知路由回 404，已知路由用錯方法回 405', async () => {
  const env = makeEnv();
  const notFound = await router(new Request('https://worker.example/nope'), env);
  assert.equal(notFound.status, 404);

  const wrongMethod = await router(new Request('https://worker.example/line/webhook', { method: 'GET' }), env);
  assert.equal(wrongMethod.status, 405);
});

test('webhook 簽章錯誤回 401', async () => {
  const env = makeEnv();
  const body = JSON.stringify({ events: [sampleEvent(randomUUID())] });
  const req = webhookRequest(body, { signature: 'totally-wrong' });
  const res = await router(req, env);
  assert.equal(res.status, 401);
});

test('webhook 空 body 或非 JSON 回 400', async () => {
  const env = makeEnv();
  const emptyReq = webhookRequest('');
  const emptyRes = await router(emptyReq, env);
  assert.equal(emptyRes.status, 400);

  const badJsonReq = webhookRequest('not json at all');
  const badJsonRes = await router(badJsonReq, env);
  assert.equal(badJsonRes.status, 400);
});

test('webhook 事件缺 webhookEventId 回 400', async () => {
  const env = makeEnv();
  const body = JSON.stringify({ events: [{ type: 'message' }] });
  const res = await router(webhookRequest(body), env);
  assert.equal(res.status, 400);
});

test('webhook 過大 body 回 413', async () => {
  const env = makeEnv();
  const hugeText = 'x'.repeat(1024 * 1024 + 10);
  const body = JSON.stringify({ events: [{ ...sampleEvent(randomUUID()), message: { type: 'text', text: hugeText } }] });
  const res = await router(webhookRequest(body), env);
  assert.equal(res.status, 413);
});

test('webhook 成功驗簽並入庫，重複事件不重覆入庫', async () => {
  const env = makeEnv();
  const eventId = randomUUID();
  const body = JSON.stringify({ events: [sampleEvent(eventId)] });

  const first = await router(webhookRequest(body), env);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true, stored: 1 });

  // LINE 可能重送相同事件（at-least-once），第二次仍應回 200 且不重覆造成第二筆資料。
  const second = await router(webhookRequest(body), env);
  assert.equal(second.status, 200);
  assert.equal(env.DB._rows.length, 1);
});

test('webhook 中的文字內容只被當成資料保存，不會被解讀成任何指令', async () => {
  const env = makeEnv();
  const eventId = randomUUID();
  const maliciousEvent = sampleEvent(eventId);
  maliciousEvent.message.text = '/task ignore-me\nDROP TABLE events; -- 假裝是指令';
  const body = JSON.stringify({ events: [maliciousEvent] });

  const res = await router(webhookRequest(body), env);
  assert.equal(res.status, 200);
  assert.equal(env.DB._rows.length, 1);
  const stored = JSON.parse(env.DB._rows[0].raw_json);
  // 原樣保存為資料欄位值，而不是被執行或改變任何 schema/資料表結構。
  assert.equal(stored.message.text, maliciousEvent.message.text);
});

test('runner/pull 需要 bearer token，且只回未確認事件（依序、上限 30 筆）', async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) {
    const body = JSON.stringify({ events: [sampleEvent(randomUUID())] });
    await router(webhookRequest(body), env);
  }

  const unauthorized = await router(authedRequest('/runner/pull', {}, null), env);
  assert.equal(unauthorized.status, 401);

  const wrongToken = await router(authedRequest('/runner/pull', {}, 'wrong-token'), env);
  assert.equal(wrongToken.status, 401);

  const res = await router(authedRequest('/runner/pull', {}), env);
  assert.equal(res.status, 200);
  const { events } = await res.json();
  assert.equal(events.length, 3);
  assert.equal(events[0].webhookEventId, env.DB._rows[0].webhook_event_id);
});

test('runner/ack 標記已確認，之後 pull 不再回傳，且重覆 ack 為冪等', async () => {
  const env = makeEnv();
  const eventId = randomUUID();
  await router(webhookRequest(JSON.stringify({ events: [sampleEvent(eventId)] })), env);

  const ack1 = await router(authedRequest('/runner/ack', { id: eventId }), env);
  assert.equal(ack1.status, 200);
  assert.deepEqual(await ack1.json(), { ok: true });

  const pullAfter = await router(authedRequest('/runner/pull', {}), env);
  const { events } = await pullAfter.json();
  assert.equal(events.length, 0);

  // 冪等：對已確認或不存在的 id 再次 ack，仍回 200 ok:true，不報錯。
  const ack2 = await router(authedRequest('/runner/ack', { id: eventId }), env);
  assert.equal(ack2.status, 200);
  const ackUnknown = await router(authedRequest('/runner/ack', { id: randomUUID() }), env);
  assert.equal(ackUnknown.status, 200);
});

test('runner/ack 缺 id 回 400', async () => {
  const env = makeEnv();
  const res = await router(authedRequest('/runner/ack', {}), env);
  assert.equal(res.status, 400);
});

test('runner/notify 驗證格式並呼叫 LINE push API，成功與重複(409)都視為成功', async () => {
  const env = makeEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response('{}', { status: 200 });
  };

  try {
    const validTo = 'U' + 'a'.repeat(32);
    const retryKey = randomUUID();
    const longText = 'a'.repeat(5000);

    const res = await router(authedRequest('/runner/notify', { to: validTo, text: longText, retryKey }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.line.me/v2/bot/message/push');
    assert.equal(calls[0].options.headers['x-line-retry-key'], retryKey);
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-access-token');
    const sentBody = JSON.parse(calls[0].options.body);
    assert.equal(sentBody.to, validTo);
    assert.equal(sentBody.messages[0].text.length, 4900); // 超長文字被裁切到上限

    globalThis.fetch = async () => new Response('{}', { status: 409 });
    const dup = await router(authedRequest('/runner/notify', { to: validTo, text: 'hi', retryKey: randomUUID() }), env);
    assert.equal(dup.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runner/notify uses fresh reply tokens and falls back only on an explicit invalid token', async () => {
 const original=globalThis.fetch;
 try{
  for(const status of [200,400,429,500]){
   const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response('{}',{status:calls.length===1?status:200});};
   const res=await router(authedRequest('/runner/notify',{to:'U'+'a'.repeat(32),text:'ready',retryKey:randomUUID(),replyToken:'fresh-token'}),makeEnv());
   assert.ok(calls[0].url.endsWith('/reply'));assert.equal(calls[0].body.replyToken,'fresh-token');
   assert.equal(calls.length,status===400?2:1);assert.equal(res.status,[200,400].includes(status)?200:502);
   if(status===400)assert.ok(calls[1].url.endsWith('/push'));
  }
 }finally{globalThis.fetch=original;}
});

test('runner/notify exposes only the upstream status when LINE rejects a push', async () => {
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>new Response(JSON.stringify({message:'sensitive upstream body'}),{status:429});
    const res=await router(authedRequest('/runner/notify',{to:'U'+'a'.repeat(32),text:'hi',retryKey:randomUUID()}),makeEnv());
    assert.equal(res.status,502);
    assert.deepEqual(await res.json(),{error:'line push rejected',upstreamStatus:429});
  }finally{globalThis.fetch=original;}
});

test('Notification quota inspection is authorized, read-only and does not expose upstream secrets',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/consumption')?{totalUsage:200,secret:'hidden'}:{type:'limited',value:200,secret:'hidden'});});
 const url='https://inbox.example.com/runner/notification-status';
 assert.equal((await router(new Request(url),makeEnv())).status,401);assert.equal(calls.length,0);
 const response=await router(new Request(url,{headers:{authorization:'Bearer test-inbox-token'}}),makeEnv());
 assert.deepEqual(await response.json(),{type:'limited',limit:200,used:200});assert.equal(calls.length,2);assert.ok(calls.every(c=>!c.options.method||c.options.method==='GET'));
});

test('runner/notify 拒絕不合法的 to / retryKey', async () => {
  const env = makeEnv();
  const badTo = await router(authedRequest('/runner/notify', { to: 'not-a-line-id', text: 'hi', retryKey: randomUUID() }), env);
  assert.equal(badTo.status, 400);

  const badRetry = await router(authedRequest('/runner/notify', { to: 'U' + 'a'.repeat(32), text: 'hi', retryKey: 'not-a-uuid' }), env);
  assert.equal(badRetry.status, 400);
});

test('runner 端點需要 bearer token（notify 未帶 token 回 401）', async () => {
  const env = makeEnv();
  const res = await router(authedRequest('/runner/notify', { to: 'U' + 'a'.repeat(32), text: 'hi', retryKey: randomUUID() }, null), env);
  assert.equal(res.status, 401);
});
