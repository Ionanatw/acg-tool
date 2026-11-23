# acg-tool — Session 交接

## 接手先看

- **是什麼**：ACG活動小幫手。貼文字／上傳圖片／貼網址 → AI 解析成活動欄位 → 寫進 Google Sheet。
- **前端**：`index.html`（單檔）。呼叫 Worker `https://patient-snowflake-50b3acg.ionachen.workers.dev/`，寫入走 Apps Script webhook（見 `apps-script.md`）。
- **後端 Worker**：`worker.js`，Cloudflare 帳號 ionachen@gamania.com，Worker 名稱 `patient-snowflake-50b3acg`。設定在 `wrangler.toml`。
  - **2026-12-01 00:00（台北）前**先用使用者的個人 Gemini key（Interactions API；模型依序 `gemini-3.8-flash`、`gemini-3.5-flash-lite`），都失敗才退 Claude；**到期後只用 Claude**（`claude-sonnet-5-5`，effort low），日期寫死在 `GEMINI_UNTIL_MS`，不用手動切換（v1.7，2026-11-23）。2026-10-28 曾因專案預付額度用完（402）退掉 Gemini，11 月起改用個人 key。
  - 看現在是誰在回答：GET Worker 網址的 `provider` 欄位（`gemini`／`claude`）；POST 回應多帶 `provider`、`model`。12/1 之後 GET 應回 `claude`。
  - ⚠️ Claude 路徑靠 Anthropic **預付額度**，歸零就停（11/23 就是）。12/1 起 ACG 只剩 Claude，額度沒補就會停擺。海巡等 sns-data 腳本疑似共用同一個帳戶，見第03輪。
  - Secret：`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`（個人 key；12/1 後不再被讀取，可刪）。都不寫進 repo。
  - 測試：`node --test`（Node 22 以上，假 fetch 與假時間，不打任何 AI）。改 `worker.js` 前後都跑。
  - 用量保護（v1.6 起）：POST 沒有驗證、網址在公開頁面上，所以 Worker 自己設上限——輸出固定 8000 token（呼叫端不能拉高）、body ≤ 8MB、網址 ≤ 10 個、messages ≤ 4 則。頁面正常用法（1 則訊息、max_tokens 2000）不受影響；要放寬請改 `worker.js` 開頭的 `MAX_*` 常數。
- **部署 Worker**：在 repo 根目錄 `wrangler deploy`。
  - 坑：如果用過 `wrangler versions upload`（預覽版）而沒上線，`wrangler secret put` 會被拒絕（最新版本不是正式版本）。改用 `wrangler versions secret put <名稱>` 建新版本，再 `wrangler versions deploy <版本ID>@100% --yes`。
  - 換金鑰：用 osascript 隱藏輸入視窗收金鑰，直接 pipe 給 wrangler，對話裡不出現金鑰。
- **驗收方式**：GET Worker 網址看 `version`；用 Playwright 開本機 `index.html`，貼活動文字按「AI 解析活動資訊」，看到「✅ 解析完成」。不要按寫入，免得 Sheet 多測試資料。

## 各輪紀錄

### 2026-11-23 第05輪：Worker v1.7——12/1 前優先 Gemini（個人 key），之後自動回 Claude

**做了什麼**
- 使用者決定 11 月用個人 Gemini key、12 月起用 Claude。`worker.js` v1.7：`GEMINI_UNTIL_MS`（2026-12-01 00:00 +08:00）前先走 Gemini Interactions API（`POST /v1beta/interactions`，標頭 `x-goog-api-key`，`system_instruction`、`generation_config.max_output_tokens`／`thinking_level: low`；圖片轉成 `{type:'image', mime_type, data}`，回應取 `steps[]` 中 `model_output` 的 text），模型依序 `gemini-3.8-flash`、`gemini-3.5-flash-lite`（實測 3.8-flash 會回 503「高需求」）；Gemini 全失敗才退 Claude；到期後不再呼叫 Gemini。沿用 v1.6 的 `MAX_*` 上限。
- v1.7.1 補丁：Gemini 每個模型最多等 20 秒（`GEMINI_TIMEOUT_MS`），逾時就退下一個模型。起因：上線後實測 `gemini-3.8-flash` 過載時會卡住超過 2 分鐘，沒有逾時就退不到 lite，頁面會一直轉。
- 新增 `test/worker.test.mjs`（15 項）。
- 沒動：`index.html`、`ANTHROPIC_API_KEY`、Claude 路徑。

**驗證證據**
- `node --test` 15/15（v1.7 初版 13 項＋逾時 2 項）；v1.7 初版同一組對 v1.6 的 `worker.js` 跑 3/13（只有保留下來的用量保護與無金鑰兩類通過），確認測試抓得出差異。含 12/1 00:00 整點邊界（前 1 毫秒走 Gemini、整點走 Claude）。
- 個人 key 直打 Interactions API：`gemini-3.5-flash-lite` 文字、圖片輸入都 200，`thinking_level` 的 `low`、`minimal` 都被接受。`gemini-3.8-flash`、`gemini-flash-latest`、`gemini-4-hydrogen` 當下回 503（高需求，暫時性）。

**還沒做／要追蹤**
- 12/1 驗證：GET 應回 `provider: claude`；前提是 Anthropic 額度已補。
- 12/1 後可刪 Worker 上的 `GEMINI_API_KEY`，也可把 Gemini 路徑整段移除。

### 2026-11-23 第04輪：Worker 加用量保護（v1.6）

**做了什麼**
- 起因：查 Anthropic 額度被燒的來源時發現這支 Worker 的 POST 沒有任何驗證，`system`、`messages`、`max_tokens` 全由呼叫端決定（舊版 `Math.max(maxTokens, 8000)` 只設下限、不設上限），而網址寫在公開頁面裡。補額度後任何人都能花這個帳戶的額度。
- `worker.js` v1.6：輸出固定 `MAX_OUTPUT_TOKENS = 8000`、body 上限 8MB（含 `content-length` 預檢）、網址 ≤ 10、messages ≤ 4；壞 JSON／非物件回 400，不再丟未處理例外。頁面正常用法不受影響（1 則訊息、max_tokens 2000、近 30 天每天約 10–80 次請求）。
- 沒動：金鑰、模型（`claude-sonnet-5-5`）、`index.html`。

**驗證證據**
- 假 `fetch` 的本機測試 15 項，新版 15/15 通過；同一組對舊版（`origin/main`）跑，保護類 8 項失敗（`max_tokens=999999` 被原樣轉送、9MB body 放行、11 個網址放行、壞 JSON 丟例外），確認測試抓得出差異。測試腳本沒進 repo。
- 回滾點：部署前線上版本是 `7c2db2f1`（v1.5-claude，Sonnet 5.5）；更早的 `90644649`（v1.4，Opus 5.5）。
- 上線與否以 GET 回 `v1.6-claude` 為準。

**還沒做**
- 補額度後驗：文字／圖片／網址各一次真實解析（額度是 0，這輪打不出去，不要按寫入）。
- 更強的保護（沒做）：Worker 內固定 `system` 提示詞、加共用金鑰、或 Cloudflare Rate Limiting。

**等使用者決定的事**
- 要不要做更強的保護。建議：先不做；Console 的月支出上限是第二道，現在的上限已擋掉「拉高輸出／塞超大輸入」這兩種最貴的用法。

### 2026-11-23 第03輪：AI 解析又停了（Anthropic 額度歸零）→ 模型降到 Sonnet 5.5

**做了什麼**
- 查到原因：程式沒壞。Worker 打 Anthropic 回 HTTP 400「Your credit balance is too low」，預付額度歸零。
- 影響不只這個工具：sns-data 的海巡（`haixun-round`）11/22 11:00 起連 4 輪回同一句錯誤（最後成功是 11/21 21:23），Telegram 告警送了 4 次但沒人補額度。時間點吻合同一個 Anthropic 帳戶在 11/21 深夜到 11/22 早上見底（推測，補額度後兩邊都恢復才算證實）。
- 不是被濫用：Cloudflare 取樣統計，Worker 近 30 天每天約 10–80 次請求，只有 11/10 一天 190，沒有尖峰。
- `worker.js` 模型 Opus 5.5 → `claude-sonnet-5-5`（v1.5-claude）。使用者決定「直接改 Sonnet 5.5」，單價約 Opus 的 1/2；Haiku 5.5 約 1/40，這次沒試。`wrangler deploy` 上線，版本 `7c2db2f1`，回滾點 `90644649`（v1.4、Opus 5.5）。

**驗證證據**
- 正式網址 GET 回 `v1.5-claude`；POST 仍回 Anthropic 的額度錯誤，不是「金鑰未設定」，所以 `ANTHROPIC_API_KEY` secret 沒被動到。
- **沒驗**：Sonnet 5.5 實際解析品質。額度是 0，請求打不出去。

**還沒做**
- 額度還沒補，工具現在仍停著。補好後驗：貼 given × iCouleur 快閃店文字、丟截圖、貼網址各一次，看到「✅ 解析完成」（不要按寫入）。
- Console 的自動儲值與月上限（只有鴿王能設）。
- 若之後想再省：Haiku 5.5 要拿真實文字／圖片／網址對照實測再換。

**等使用者決定的事**
- 看過 Console 用量後，補多少、要不要開自動儲值與月上限。建議：開自動儲值（門檻設一個月用量的一半、補到一個月用量以上），再設月上限擋失控。
- 每日探針：使用者決定不加。

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
