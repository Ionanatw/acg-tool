// ACG Tool Worker
// Version: v1.7.1 (2026-12-01 前優先 Gemini，之後自動回 Claude Sonnet 5.5；Gemini 每個模型 20 秒逾時) — 2026-11-23
// 對應前端 index.html 版本：v1.1-text-image-url
// 後端：2026-12-01 00:00（台北）前先用個人 Gemini key（Interactions API），失敗再退 Claude；
// 到期後只用 Anthropic Claude，不需要任何人手動切換（日期寫死在 GEMINI_UNTIL_MS）。

async function fetchUrlText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ACGBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      }
    });
    if (!resp.ok) return `[無法讀取 ${url}，狀態碼：${resp.status}]`;

    const html = await resp.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 6000);

    return `[來源：${url}]\n${text}`;
  } catch (e) {
    return `[讀取 ${url} 時發生錯誤：${e.message}]`;
  }
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const CLAUDE_MODEL = 'claude-sonnet-5-5';

// 用量保護（2026-11-23）：這支 Worker 的 POST 沒有驗證，網址又寫在公開頁面裡，
// 任何人都能指定 max_tokens 和一大包輸入來花額度。下面的上限對頁面的正常使用沒有影響：
// 頁面只送 1 則 user 訊息、max_tokens 2000（Worker 本來就墊到 8000）、網址一行一個。
const MAX_OUTPUT_TOKENS = 8000;          // 呼叫端不能自己拉高
const MAX_BODY_BYTES = 8 * 1024 * 1024;  // Anthropic 單張圖上限 5MB，base64 後約 6.7MB
const MAX_URLS = 10;
const MAX_MESSAGES = 4;

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status, headers: CORS_HEADERS,
  });
}

// 前端送來的 messages 本來就是 Anthropic 格式，直接轉送
async function callClaude(apiKey, system, messages) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: 'low' },
      system,
      messages,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${data?.error?.message || ''}`.trim());
  if (data.stop_reason === 'refusal') throw new Error('模型拒絕回答');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error(`回傳內容是空的（stop_reason: ${data.stop_reason}）`);
  return { text, usage: data.usage ?? null };
}

// ---- Gemini（Interactions API；generateContent 對新 key 已不開放）----
// 依序嘗試：2026-11-23 實測 3.8-flash 會回 503「高需求」（暫時性），lite 較弱但比整個失敗好
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];
// 每個模型最多等這麼久：2026-11-23 實測 3.8-flash 過載時會卡住超過 2 分鐘，沒有逾時就退不到下一個模型
const GEMINI_TIMEOUT_MS = 20000;
// 2026-12-01 00:00 台北時間起不再用 Gemini（11 月用個人 key，12 月起回 Claude）
const GEMINI_UNTIL_MS = Date.parse('2026-12-01T00:00:00+08:00');

function geminiActive(env) {
  return Boolean(env.GEMINI_API_KEY) && Date.now() < GEMINI_UNTIL_MS;
}

// Anthropic 格式的 content（字串或 text／image 區塊）→ Gemini 的 content 陣列
function toGeminiContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && block.source?.type === 'base64') {
      parts.push({ type: 'image', mime_type: block.source.media_type, data: block.source.data });
    }
  }
  return parts;
}

// 單則訊息直接送 content 陣列；多則用 steps（user_input／model_output）
function toGeminiInput(messages) {
  if (messages.length === 1) return toGeminiContent(messages[0].content);
  return messages.map(m => ({
    type: m.role === 'assistant' ? 'model_output' : 'user_input',
    content: toGeminiContent(m.content),
  }));
}

async function callGeminiModel(apiKey, model, system, messages) {
  const body = {
    model,
    input: toGeminiInput(messages),
    generation_config: { max_output_tokens: MAX_OUTPUT_TOKENS, thinking_level: 'low' },
  };
  if (system) body.system_instruction = system;
  const resp = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${data?.error?.message || ''}`.trim());
  const text = (data.steps || [])
    .filter(s => s.type === 'model_output')
    .flatMap(s => s.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');
  if (!text) throw new Error('回傳內容是空的');
  return { text, usage: data.usage ?? null };
}

async function callGemini(apiKey, system, messages) {
  const errors = [];
  for (const model of GEMINI_MODELS) {
    try {
      const { text, usage } = await callGeminiModel(apiKey, model, system, messages);
      return { text, usage, model, skipped: errors };
    } catch (e) {
      errors.push(`${model}：${e.message}`);
    }
  }
  throw new Error(errors.join('；'));
}

// provider／model／usage 讓呼叫端看得出這次實際是誰回答、花了多少 token（前端只讀 content[0].text，多的欄位無影響）
function okResponse(text, provider, model, usage) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }], provider, model, usage }), {
    headers: CORS_HEADERS,
  });
}

// 用量紀錄（v1.8）：每個 POST 一行 JSON，進 Cloudflare Workers Logs（wrangler.toml 開 observability）。
// 只記用了誰、token 數、耗時與失敗原因，不記使用者輸入的內容。
function logUsage(entry) {
  console.log(JSON.stringify({ event: 'acg_parse', ...entry }));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    if (request.method === 'GET') {
      // provider＝「此刻」會優先用誰；12/1 驗證只要看這個欄位是不是 claude
      return new Response(JSON.stringify({
        status: 'ok',
        version: 'v1.8-usage-log',
        provider: geminiActive(env) ? 'gemini' : 'claude',
      }), { headers: CORS_HEADERS });
    }

    if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
      return errorResponse(413, '請求太大');
    }
    const bodyText = await request.text();
    if (bodyText.length > MAX_BODY_BYTES) return errorResponse(413, '請求太大');

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch (e) {
      return errorResponse(400, '請求格式錯誤');
    }
    if (!body || typeof body !== 'object') return errorResponse(400, '請求格式錯誤');

    let userMessages;

    // URL 模式：先抓取網址內容
    if (body.sourceType === 'url' && Array.isArray(body.urls) && body.urls.length > 0) {
      if (body.urls.length > MAX_URLS) {
        return errorResponse(400, `一次最多 ${MAX_URLS} 個網址`);
      }
      const fetchedTexts = await Promise.all(body.urls.map(fetchUrlText));
      const combinedText = fetchedTexts.join('\n\n---\n\n');
      userMessages = [{
        role: 'user',
        content: `請解析以下從活動網址抓取的內容，找出所有 ACG 活動資訊：\n\n${combinedText}`
      }];
    } else {
      userMessages = body.messages || [];
    }

    if (!Array.isArray(userMessages) || userMessages.length > MAX_MESSAGES) {
      return errorResponse(400, '請求格式錯誤');
    }

    const system = body.system || '';

    const providers = [];
    if (geminiActive(env)) providers.push('gemini');
    if (env.ANTHROPIC_API_KEY) providers.push('claude');
    if (providers.length === 0) {
      return new Response(JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY 未設定' } }), {
        status: 500, headers: CORS_HEADERS,
      });
    }

    const started = Date.now();
    const mode = body.sourceType === 'url' ? 'url' : 'messages';
    const errors = [];
    for (const provider of providers) {
      try {
        if (provider === 'gemini') {
          const { text, model, usage, skipped } = await callGemini(env.GEMINI_API_KEY, system, userMessages);
          logUsage({ ok: true, provider, model, usage, mode, ms: Date.now() - started, errors: [...errors, ...skipped] });
          return okResponse(text, provider, model, usage);
        }
        const { text, usage } = await callClaude(env.ANTHROPIC_API_KEY, system, userMessages);
        logUsage({ ok: true, provider, model: CLAUDE_MODEL, usage, mode, ms: Date.now() - started, errors });
        return okResponse(text, provider, CLAUDE_MODEL, usage);
      } catch (e) {
        errors.push(`${provider === 'gemini' ? 'Gemini' : 'Claude'} 錯誤：${e.message}`);
      }
    }
    logUsage({ ok: false, mode, ms: Date.now() - started, errors });
    return new Response(JSON.stringify({ error: { message: errors.join('｜') } }), {
      status: 502, headers: CORS_HEADERS,
    });
  }
}
