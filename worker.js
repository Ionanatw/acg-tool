// ACG Tool Worker
// Version: v1.1 (TEXT+IMAGE+URL) — 2026-03-13
// 對應前端 index.html 版本：v1.1-text-image-url

// 抓取網址，並清洗 HTML 為純文字
async function fetchUrlText(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        // 模擬瀏覽器，減少被封鎖的機率
        'User-Agent': 'Mozilla/5.0 (compatible; ACGBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      }
    });
    if (!resp.ok) return `[無法讀取 ${url}，狀態碼：${resp.status}]`;

    const html = await resp.text();

    // 簡易 HTML 清洗：移除 script/style/tag，保留純文字
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
      .slice(0, 6000); // 每個網址最多 6000 字，避免超出 Token 限制

    return `[來源：${url}]\n${text}`;
  } catch (e) {
    return `[讀取 ${url} 時發生錯誤：${e.message}]`;
  }
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    // 健康檢查
    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', version: 'v1.1' }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    const bodyText = await request.text();
    const body = JSON.parse(bodyText);
    const apiKey = env.ANTHROPIC_API_KEY;

    // 如果是 URL 模式，先抓取網址內容，再組成新的 messages
    if (body.sourceType === 'url' && Array.isArray(body.urls) && body.urls.length > 0) {
      // 平行抓取所有網址內容
      const fetchedTexts = await Promise.all(body.urls.map(fetchUrlText));
      const combinedText = fetchedTexts.join('\n\n---\n\n');

      // 重新組建送給 Anthropic 的 body（移除自訂欄位，換成抓好的文字）
      const anthropicBody = {
        model: body.model,
        max_tokens: body.max_tokens,
        system: body.system,
        messages: [
          {
            role: 'user',
            content: `請解析以下從活動網址抓取的內容，找出所有 ACG 活動資訊：\n\n${combinedText}`
          }
        ]
      };

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicBody),
      });

      const data = await resp.json();
      const text = data?.content?.[0]?.text ?? JSON.stringify(data);

      return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // 一般模式（文字 / 圖片）：直接轉送給 Anthropic
    // 移除前端自訂的欄位，避免 Anthropic API 拒絕
    const { sourceType, urls, ...anthropicBody } = body;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await resp.json();
    const text = data?.content?.[0]?.text ?? JSON.stringify(data);

    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}
