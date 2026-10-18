# quota-resume

當訂閱配額耗盡，而且伺服器明確提供未來重設時間時，在目前工作階段等待後自動送出一次：

```text
Continue the unfinished task.
```

原提示與已完成的工具結果留在原對話。不重送原提示，不切換模型或付費備援，不查詢額外用量端點。

## 支援範圍

- Claude 直連訂閱。辨識 `rate_limit_error` 與拒絕使用的 unified subscription 標頭。一般 API token/request 限流不算訂閱配額。
- OpenCode Go。辨識 `GoUsageLimitError` 與 `Retry-After`。
- OpenAI Codex。辨識 HTTP 與原始串流事件中的 `usage_limit_reached`，讀取明確的重設時間或剩餘秒數。

保留原生 provider 驗證、模型覆寫、請求選項及 OpenCode session header。只有主代理最後失敗的回合可建立待恢復紀錄；巢狀呼叫不會自行觸發。

缺少有效重設時間，或新收到的重設時間已過期時，顯示通知但不自動續跑。原本有效的待恢復紀錄若於重開工作階段時已到期，仍可送出一次。

## 取消與持久化

使用 `/quota-resume cancel` 取消。TUI 按 Escape 也可取消，按鍵仍傳給 Pi。新輸入、使用者 bash、自訂訊息啟動的新工作、執行中止、模型變更與工作階段導覽都會取消。

退出或重新載入會保留待恢復紀錄。再次開啟同一工作階段與分支時恢復等待。沒有離線 daemon。

RPC 閒置時的通用 `abort` 沒有公開 extension 事件，無法用它取消等待。RPC 請送出 `/quota-resume cancel` 或新輸入。此限制沒有用私有攔截繞過。

每筆恢復紀錄最多派送一次。先持久化 consumed，再送出訊息；若程序恰好在兩者之間崩潰，該次續跑可能遺失，不保證跨程序崩潰的 exactly-once delivery。

## 本機驗證

```sh
npm run typecheck
node --test --test-timeout=60000 extensions/quota-resume/test/*.test.mjs
node extensions/quota-resume/test/runtime-fixture.mjs 20
```

最後一個命令啟動只監聽 loopback 的 fixture，輸出暫存目錄、`launch.sh` 與紀錄路徑。於另一個終端機執行輸出的 launch 命令，送出 `Finish the fixture task.`。等待通知後按 Escape，或不取消以觀察續跑。重開相同 launch 命令可檢查持久化。所有設定、假驗證資料與 session 均放在 OS 暫存目錄，不使用個人 auth。

SDK 與 spawned RPC 測試使用真實 Pi 1.3.0 搭配本機 HTTP fixture，另有原生 Codex 連接本機 WebSocket server 的測試。終端按鍵合約測試不等於實際 TUI 驗證。Claude unified 標頭不是穩定公開 API；fixture 通過不代表真實帳戶已驗證。OpenCode 線上帳戶驗證仍受過期金鑰阻擋，未修改憑證。
