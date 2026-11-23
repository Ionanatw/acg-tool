// 執行：node --test（Node 22 以上，不用裝任何套件）
// 用假 fetch 與假時間測 worker.js，不會真的呼叫任何 AI 服務。
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const BEFORE_CUTOFF = Date.parse('2026-11-30T23:59:59.999+08:00');
const AT_CUTOFF = Date.parse('2026-12-01T00:00:00.000+08:00');

// 在 fn 執行期間換掉 fetch 與 Date.now；calls 記錄每次對外呼叫
async function withFakes({ now, handlers }, fn) {
  const realFetch = globalThis.fetch, realNow = Date.now;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const h = handlers[url];
    if (!h) throw new Error('沒預期的呼叫：' + url);
    const { status = 200, json } = typeof h === 'function' ? h(call) : h;
    return new Response(JSON.stringify(json), { status });
  };
  Date.now = () => now;
  try { return await fn(calls); } finally { globalThis.fetch = realFetch; Date.now = realNow; }
}

const geminiOk = (text) => ({ json: { id: 'int_1', steps: [
  { type: 'model_output', content: [{ type: 'text', text }] }] } });
const claudeOk = (text) => ({ json: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });

const post = (body, env) => worker.fetch(new Request('https://w.test/', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), env);
const get = (env) => worker.fetch(new Request('https://w.test/', { method: 'GET' }), env);
const KEYS = { GEMINI_API_KEY: 'g-key', ANTHROPIC_API_KEY: 'a-key' };
const ONE_MSG = { system: '你是活動解析器', max_tokens: 999999,
  messages: [{ role: 'user', content: [{ type: 'text', text: '活動 A' }] }] };

test('12/1 前：先走 Gemini，請求格式符合 Interactions API', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: { [GEMINI_URL]: geminiOk('GEMINI 答案') } }, async (calls) => {
    const resp = await post(ONE_MSG, KEYS);
    const data = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(data.content[0].text, 'GEMINI 答案');
    assert.equal(data.provider, 'gemini');
    assert.equal(data.model, 'gemini-3.8-flash');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['x-goog-api-key'], 'g-key');
    assert.equal(calls[0].body.system_instruction, '你是活動解析器');
    assert.deepEqual(calls[0].body.input, [{ type: 'text', text: '活動 A' }]);
    assert.equal(calls[0].body.generation_config.max_output_tokens, 8000); // 呼叫端拉高 max_tokens 無效
    assert.equal(calls[0].body.model, 'gemini-3.8-flash');
  });
});

test('Gemini 主模型 503（高需求）→ 先退 flash-lite，不用動到 Claude', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {
    [GEMINI_URL]: (call) => call.body.model === 'gemini-3.8-flash'
      ? { status: 503, json: { error: { code: 'service_unavailable', message: 'high demand' } } }
      : geminiOk('LITE 答案') } }, async (calls) => {
    const data = await (await post(ONE_MSG, KEYS)).json();
    assert.equal(data.provider, 'gemini');
    assert.equal(data.model, 'gemini-3.5-flash-lite');
    assert.equal(data.content[0].text, 'LITE 答案');
    assert.deepEqual(calls.map(c => c.body.model), ['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
  });
});

test('邊界：12/1 00:00（台北）整點起改走 Claude，即使有 Gemini key 也不呼叫', async () => {
  await withFakes({ now: AT_CUTOFF, handlers: { [CLAUDE_URL]: claudeOk('CLAUDE 答案') } }, async (calls) => {
    const data = await (await post(ONE_MSG, KEYS)).json();
    assert.equal(data.content[0].text, 'CLAUDE 答案');
    assert.equal(data.provider, 'claude');
    assert.deepEqual(calls.map(c => c.url), [CLAUDE_URL]);
  });
});

test('GET 的 provider 欄位跟著日期變（12/1 驗證用）', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {} }, async () => {
    const d = await (await get(KEYS)).json();
    assert.equal(d.provider, 'gemini');
    assert.match(d.version, /^v1\.7/);
  });
  await withFakes({ now: AT_CUTOFF, handlers: {} }, async () => {
    assert.equal((await (await get(KEYS)).json()).provider, 'claude');
  });
  await withFakes({ now: BEFORE_CUTOFF, handlers: {} }, async () => { // 沒設 Gemini key 也是 claude
    assert.equal((await (await get({ ANTHROPIC_API_KEY: 'a' })).json()).provider, 'claude');
  });
});

test('Gemini 失敗（HTTP 402）→ 退 Claude', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {
    [GEMINI_URL]: { status: 402, json: { error: { code: 'payment_required', message: 'credits depleted' } } },
    [CLAUDE_URL]: claudeOk('CLAUDE 備援') } }, async (calls) => {
    const data = await (await post(ONE_MSG, KEYS)).json();
    assert.equal(data.provider, 'claude');
    assert.equal(data.content[0].text, 'CLAUDE 備援');
    assert.deepEqual(calls.map(c => c.url), [GEMINI_URL, GEMINI_URL, CLAUDE_URL]); // 兩個 Gemini 模型都試過才退 Claude
  });
});

test('兩邊都失敗 → 502，訊息帶兩邊原因', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {
    [GEMINI_URL]: { status: 404, json: { error: { message: 'model not found' } } },
    [CLAUDE_URL]: { status: 400, json: { error: { message: 'credit balance too low' } } } } }, async () => {
    const resp = await post(ONE_MSG, KEYS);
    const msg = (await resp.json()).error.message;
    assert.equal(resp.status, 502);
    assert.match(msg, /Gemini 錯誤：gemini-3\.8-flash：HTTP 404 model not found；gemini-3\.5-flash-lite：HTTP 404/);
    assert.match(msg, /Claude 錯誤：HTTP 400 credit balance too low/);
  });
});

test('Gemini 回空內容 → 當失敗退 Claude', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {
    [GEMINI_URL]: { json: { steps: [{ type: 'model_output', content: [] }] } },
    [CLAUDE_URL]: claudeOk('CLAUDE 備援') } }, async () => {
    assert.equal((await (await post(ONE_MSG, KEYS)).json()).provider, 'claude');
  });
});

test('只有 Gemini key（沒設 Claude）→ 12/1 前能用、12/1 後 500', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: { [GEMINI_URL]: geminiOk('ok') } }, async () => {
    assert.equal((await post(ONE_MSG, { GEMINI_API_KEY: 'g' })).status, 200);
  });
  await withFakes({ now: AT_CUTOFF, handlers: {} }, async (calls) => {
    const resp = await post(ONE_MSG, { GEMINI_API_KEY: 'g' });
    assert.equal(resp.status, 500);
    assert.equal(calls.length, 0);
  });
});

test('沒有任何金鑰 → 500 ANTHROPIC_API_KEY 未設定', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {} }, async () => {
    const resp = await post(ONE_MSG, {});
    assert.equal(resp.status, 500);
    assert.match((await resp.json()).error.message, /ANTHROPIC_API_KEY 未設定/);
  });
});

test('圖片區塊轉成 Gemini 格式；多則訊息用 steps', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: { [GEMINI_URL]: geminiOk('ok') } }, async (calls) => {
    await post({ messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '解析' }] }] }, KEYS);
    assert.deepEqual(calls[0].body.input, [
      { type: 'image', mime_type: 'image/png', data: 'QUJD' }, { type: 'text', text: '解析' }]);
    assert.equal('system_instruction' in calls[0].body, false); // 沒給 system 就不送空字串

    await post({ messages: [
      { role: 'user', content: '第一句' }, { role: 'assistant', content: '回覆' }, { role: 'user', content: '第二句' }] }, KEYS);
    assert.deepEqual(calls[1].body.input.map(s => s.type), ['user_input', 'model_output', 'user_input']);
    assert.deepEqual(calls[1].body.input[0].content, [{ type: 'text', text: '第一句' }]);
  });
});

test('URL 模式：抓到的網頁文字會送進 Gemini', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {
    'https://ex.test/a': { json: {} },
    [GEMINI_URL]: geminiOk('ok') } }, async (calls) => {
    // fetchUrlText 讀 resp.text()，這裡的假回應是 JSON 字串即可
    await post({ sourceType: 'url', urls: ['https://ex.test/a'] }, KEYS);
    const sent = calls.find(c => c.url === GEMINI_URL).body.input[0].text;
    assert.match(sent, /來源：https:\/\/ex\.test\/a/);
  });
});

// ---- v1.6 的用量保護仍然有效 ----
test('用量保護：GET 以外的壞請求不會打到任何 AI', async () => {
  await withFakes({ now: BEFORE_CUTOFF, handlers: {} }, async (calls) => {
    assert.equal((await post('{壞掉', KEYS)).status, 400);
    assert.equal((await post('null', KEYS)).status, 400);
    assert.equal((await post({ sourceType: 'url', urls: Array(11).fill('https://x.test/') }, KEYS)).status, 400);
    assert.equal((await post({ messages: Array(5).fill({ role: 'user', content: 'x' }) }, KEYS)).status, 400);
    assert.equal((await post('x'.repeat(8 * 1024 * 1024 + 1), KEYS)).status, 413);
    assert.equal(calls.length, 0);
  });
});

test('用量保護：Claude 路徑輸出上限固定 8000', async () => {
  await withFakes({ now: AT_CUTOFF, handlers: { [CLAUDE_URL]: claudeOk('ok') } }, async (calls) => {
    await post(ONE_MSG, KEYS);
    assert.equal(calls[0].body.max_tokens, 8000);
    assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
  });
});
