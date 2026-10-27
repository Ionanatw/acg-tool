// ACG Tool Worker
// Version: v1.3 (Gemini → Claude 備援) — 2026-10-27
// 對應前端 index.html 版本：v1.1-text-image-url
// 先用 Google Gemini API；Gemini 失敗（額度用完、限流、當機）時改用 Anthropic Claude

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

// 將前端 Anthropic 格式的 messages 轉換成 Gemini contents
function convertToGeminiContents(messages) {
  const contents = [];
  for (const msg of messages) {
    const parts = [];
    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'image' && block.source?.type === 'base64') {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            }
          });
        }
      }
    }
    contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

const GEMINI_MODEL = 'gemini-2.5-flash';
const CLAUDE_MODEL = 'claude-opus-5-5';

async function callGemini(apiKey, system, messages, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: convertToGeminiContents(messages),
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${data?.error?.message || ''}`.trim());
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('回傳內容是空的');
  return text;
}

// 前端送來的 messages 本來就是 Anthropic 格式，直接轉送
async function callClaude(apiKey, system, messages, maxTokens) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: Math.max(maxTokens, 8000),
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

function okResponse(text, provider) {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }], provider }), {
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
      return new Response(JSON.stringify({ status: 'ok', version: 'v1.3-gemini-claude' }), {
        headers: CORS_HEADERS,
      });
    }

    const bodyText = await request.text();
    const body = JSON.parse(bodyText);

    let userMessages;

    // URL 模式：先抓取網址內容
    if (body.sourceType === 'url' && Array.isArray(body.urls) && body.urls.length > 0) {
      const fetchedTexts = await Promise.all(body.urls.map(fetchUrlText));
      const combinedText = fetchedTexts.join('\n\n---\n\n');
      userMessages = [{
        role: 'user',
        content: `請解析以下從活動網址抓取的內容，找出所有 ACG 活動資訊：\n\n${combinedText}`
      }];
    } else {
      userMessages = body.messages || [];
    }

    const system = body.system || '';
    const maxTokens = body.max_tokens || 2000;
    const errors = [];

    if (env.GEMINI_API_KEY) {
      try {
        const text = await callGemini(env.GEMINI_API_KEY, system, userMessages, maxTokens);
        return okResponse(text, 'gemini');
      } catch (e) {
        errors.push(`Gemini：${e.message}`);
      }
    }

    if (env.ANTHROPIC_API_KEY) {
      try {
        const text = await callClaude(env.ANTHROPIC_API_KEY, system, userMessages, maxTokens);
        return okResponse(text, 'claude');
      } catch (e) {
        errors.push(`Claude：${e.message}`);
      }
    }

    if (errors.length === 0) errors.push('GEMINI_API_KEY 與 ANTHROPIC_API_KEY 都未設定');
    return new Response(JSON.stringify({ error: { message: 'AI 服務都無法使用 — ' + errors.join('｜') } }), {
      status: 502, headers: CORS_HEADERS,
    });
  }
}
