// ACG Tool Worker
// Version: v1.2 (Gemini) — 2026-06-12
// 對應前端 index.html 版本：v1.1-text-image-url
// 後端改用 Google Gemini API

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
      return new Response(JSON.stringify({ status: 'ok', version: 'v1.2-gemini' }), {
        headers: CORS_HEADERS,
      });
    }

    const bodyText = await request.text();
    const body = JSON.parse(bodyText);
    const apiKey = env.GEMINI_API_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: 'GEMINI_API_KEY 未設定' } }), {
        status: 500, headers: CORS_HEADERS,
      });
    }

    const model = 'gemini-2.5-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

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

    const geminiBody = {
      contents: convertToGeminiContents(userMessages),
      systemInstruction: {
        parts: [{ text: body.system || '' }]
      },
      generationConfig: {
        maxOutputTokens: body.max_tokens || 2000,
      },
    };

    try {
      const resp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });

      const data = await resp.json();

      if (!resp.ok) {
        const errMsg = data?.error?.message || 'Gemini API 錯誤';
        return new Response(JSON.stringify({ error: { message: errMsg } }), {
          status: resp.status, headers: CORS_HEADERS,
        });
      }

      // 將 Gemini 回應轉換成前端期望的 Anthropic 格式
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
        headers: CORS_HEADERS,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: 'Worker 錯誤：' + e.message } }), {
        status: 500, headers: CORS_HEADERS,
      });
    }
  }
}
