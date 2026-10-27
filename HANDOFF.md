# acg-tool — Session 交接

## 接手先看

- **是什麼**：ACG活動小幫手。貼文字／上傳圖片／貼網址 → AI 解析成活動欄位 → 寫進 Google Sheet。
- **前端**：`index.html`（單檔）。呼叫 Worker `https://patient-snowflake-50b3acg.ionachen.workers.dev/`，寫入走 Apps Script webhook（見 `apps-script.md`）。
- **後端 Worker**：`worker.js`，Cloudflare 帳號 ionachen@gamania.com，Worker 名稱 `patient-snowflake-50b3acg`。設定在 `wrangler.toml`。
  - 只用 Claude（`claude-opus-5-5`，effort low）。2026-10-28 使用者決定不再用 Gemini。
  - Secret：`ANTHROPIC_API_KEY`（不寫進 repo）。Worker 上還留著沒在用的 `GEMINI_API_KEY`。
- **部署 Worker**：在 repo 根目錄 `wrangler deploy`。
  - 坑：如果用過 `wrangler versions upload`（預覽版）而沒上線，`wrangler secret put` 會被拒絕（最新版本不是正式版本）。改用 `wrangler versions secret put <名稱>` 建新版本，再 `wrangler versions deploy <版本ID>@100% --yes`。
  - 換金鑰：用 osascript 隱藏輸入視窗收金鑰，直接 pipe 給 wrangler，對話裡不出現金鑰。
- **驗收方式**：GET Worker 網址看 `version`；用 Playwright 開本機 `index.html`，貼活動文字按「AI 解析活動資訊」，看到「✅ 解析完成」。不要按寫入，免得 Sheet 多測試資料。

## 各輪紀錄

### 2026-10-28 第02輪：改成只用 Claude，拿掉 Gemini

**做了什麼**
- `worker.js` 刪掉 Gemini 呼叫與格式轉換，只打 Claude（v1.4-claude）；錯誤訊息改成「Claude 錯誤：…」。
- `index.html` 拿掉送給 Worker 的 `model: 'gemini-2.5-flash'`（Worker 本來就沒在讀這個欄位）。
- 加 `.gitignore` 忽略 `.wrangler/`。
- `wrangler deploy` 上線，版本 `90644649`。

**驗證證據**
- 正式網址 GET 回 `v1.4-claude`。
- 本機前端接正式 Worker，貼 given × iCouleur 快閃店文字 → 「✅ 解析完成，找到 1 個活動」，欄位正確。
- 圖片模式丟截圖進正式 Worker，解析正確。
- 網址模式沒有測；沒有按寫入 Google Sheet。

**還沒做**
- Worker 上沒在用的 `GEMINI_API_KEY` secret 還沒刪。
- Claude 文字模式的回覆開頭偶爾多一個 `<br>`，前端用正規表示式抓陣列不受影響，沒處理。

**等使用者決定的事**
- 要不要刪掉 `GEMINI_API_KEY` secret（`wrangler secret delete GEMINI_API_KEY`）。

### 2026-10-28 第01輪：AI 解析壞掉（Gemini 額度用完）→ 加 Claude 備援並換新金鑰

**做了什麼**
- 查到原因：程式沒壞。Gemini 專案預付額度用完（HTTP 402），Worker 上舊的 `ANTHROPIC_API_KEY` 也失效（401）。
- `worker.js` 改成 Gemini → Claude 備援（v1.3-gemini-claude），補 `wrangler.toml`。commit `43d4560`。
- 使用者用隱藏輸入視窗提供新的 Anthropic 金鑰（先打 `/v1/models` 驗證，HTTP 200），以 `wrangler versions secret put` 存進新版本 `b176ce4d`，再上線 100%。

**驗證證據**
- 上線前：用本機前端接版本預覽網址，貼使用者截圖那段 given × iCouleur 快閃店文字 → 「✅ 解析完成，找到 1 個活動」，標題、地點、日期 2026/12/04–12/27、時間 11:00-19:30 都正確。
- 上線後：正式網址 GET 回 `v1.3-gemini-claude`；同一段文字在正式網址重跑，結果一樣成功。
- 圖片模式：把截圖丟進正式 Worker，Claude 正確解析出活動（`provider: claude`）。
- 網址模式沒有測。沒有按寫入 Google Sheet。

**還沒做**
- Gemini 額度沒補，目前每次請求都會先打 Gemini 拿到 402，再改用 Claude（多一次很快的往返，不影響結果）。
- 前端 `index.html` 沒改；顯示的錯誤訊息還是英文原文。

**等使用者決定的事**
- ~~Gemini 要不要儲值~~ → 第02輪：使用者決定不再用 Gemini，改成只用 Claude。
- 舊的 rollback 版本：`79c5fca9`（只用 Gemini 的 v1.2）。
