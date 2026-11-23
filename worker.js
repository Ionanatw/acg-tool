// ACG Tool Worker
// Version: v1.6 (Claude Sonnet 5.5，加用量保護) — 2026-11-23
// 對應前端 index.html 版本：v1.1-text-image-url
// 後端只用 Anthropic Claude（2026-10-28 起不再用 Gemini）

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
  return text;
}

function okResponse(text) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    headers: CORS_HEADERS,
  });
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
      return new Response(JSON.stringify({ status: 'ok', version: 'v1.6-claude' }), {
        headers: CORS_HEADERS,
      });
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

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY 未設定' } }), {
        status: 500, headers: CORS_HEADERS,
      });
    }

    try {
      const text = await callClaude(env.ANTHROPIC_API_KEY, system, userMessages);
      return okResponse(text);
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: 'Claude 錯誤：' + e.message } }), {
        status: 502, headers: CORS_HEADERS,
      });
    }
  }
}
