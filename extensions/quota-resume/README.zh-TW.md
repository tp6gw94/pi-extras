# quota-resume

[English](README.md)

若訂閱配額耗盡，且伺服器明確提供未來的重設時間，擴充功能會在目前工作階段等待。重設後自動送出一次固定訊息：

```text
Continue the unfinished task.
```

原提示和已完成的工具結果會留在原對話。擴充功能不會重送原提示、不會更換模型或改用付費備援，也不會查詢用量端點。

## 支援範圍

- Claude 直連訂閱使用 `anthropic`。擴充功能辨識 `rate_limit_error`，並要求 unified 訂閱配額標頭回報 `rejected` 或 `rate_limited`。不支援 Claude CLI bridge。
- OpenCode Go 使用 `opencode-go`。擴充功能辨識 `GoUsageLimitError`，並讀取 `Retry-After`。
- OpenAI Codex 使用 `openai-codex`。擴充功能辨識 HTTP 錯誤和原始串流事件中的 `usage_limit_reached`，並讀取明確的重設時間或剩餘秒數。

一般 HTTP 429、API token 用量限制和請求頻率限制，都不足以判定訂閱配額耗盡。

擴充功能保留供應商原有的驗證方式、模型覆寫和請求選項，也保留 OpenCode 的 `x-opencode-session` 標頭。只有主代理最後失敗的回合會建立等待紀錄。巢狀呼叫不會建立紀錄。

## 等待與續跑

若伺服器沒有提供有效的重設時間，或收到回應時重設時間已過，擴充功能會顯示通知，但不會自動續跑。先前有效的等待紀錄若在重開工作階段時已到重設時間，仍可續跑一次。

## 取消與保存

`/quota-resume cancel` 會取消等待。TUI 按 Escape 也會取消，且按鍵仍會傳給 Pi。下列操作也會取消等待：

- 送出新輸入。
- 執行使用者 bash 命令。
- 透過自訂訊息啟動新工作。
- 中止執行。
- 更換模型。
- 切換工作階段、建立分支或導覽工作階段樹。

重新開啟時還原原模型不會取消等待。退出或重新載入 Pi 會保留等待紀錄，重新開啟同一工作階段和分支時會繼續等待。Pi 關閉期間，擴充功能不會自動續跑。

RPC 閒置時收到的通用 `abort` 不會觸發公開的擴充功能事件，因此無法用它取消等待。RPC 可用 `/quota-resume cancel` 或新輸入取消等待。擴充功能不會透過私有 API 或修改 Pi 核心來繞過此限制。

每筆等待紀錄最多自動送出一次續跑訊息。擴充功能會先把紀錄標為已處理並存入工作階段，再送出訊息。若程序在存入紀錄後、送出訊息前崩潰，這次續跑會遺失。

## 本機驗證

```sh
npm run typecheck
node --test --test-timeout=60000 extensions/quota-resume/test/*.test.mjs
node extensions/quota-resume/test/runtime-fixture.mjs 20
```

第三個命令啟動只監聽 `127.0.0.1` 的本機測試伺服器，並輸出暫存目錄、`launch.sh` 啟動命令和紀錄路徑。`launch.sh` 使用暫存設定啟動 Pi，測試提示是 `Finish the fixture task.`。相同啟動命令會重開同一工作階段，可用來檢查等待紀錄是否保留。設定、假驗證資料與工作階段都存於系統暫存目錄，不使用個人驗證資料。

SDK 和 RPC 子程序測試使用 Pi 1.3.0 與本機 HTTP 測試伺服器。原生 Codex 測試連接本機 WebSocket 伺服器。終端按鍵合約測試不等於實際 TUI 驗證。

Claude unified 標頭不是穩定的公開 API。本機測試通過不代表已驗證真實訂閱配額耗盡時的行為。
