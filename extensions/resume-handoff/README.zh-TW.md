# pi-resume-handoff

[English](README.md)

pi-resume-handoff 是 [pi](https://github.com/earendil-works/pi) 的 extension，從交接檔案開始新的 session。`/resume-handoff auto` 請目前 agent 撰寫檔案，`/resume-handoff <路徑>` 使用既有檔案。extension 也可以在 context 用量達到門檻時自動交接。

## 從交接檔案接續工作

`/resume-handoff auto` 請目前 agent 在獨立的系統暫存目錄撰寫交接檔案。生成成功且檔案通過驗證後，指令直接建立新 session，不要求審核或選檔。生成失敗或中止時不切換 session。新的使用者輸入或 session 導覽會取消自動切換。

`/resume-handoff "./handoff reviewed.md"` 使用既有檔案。`/resume-handoff` 從目前對話尋找已建立的交接檔案，有多個符合條件的檔案時提供選擇。若檔名就是 `auto`，使用 `"auto"` 或 `./auto`。

所有模式都會送出英文啟動指示，要求新 agent 的第一個動作讀取精確的交接檔案路徑，再接續工作。不論成功或失敗，生成的檔案都會留在暫存目錄。確認沒有 session 需要它後可自行刪除。

如果 annotation 伺服器正在執行，手動或自動交接都會讓伺服器留在原本的 port。已連接的終端機檢視與開啟的瀏覽器分頁會跟到新 session，並保留尚未送出的筆記。其他任何 session 切換都會關閉伺服器。詳見 [annotation README](../annotation/README.zh-TW.md)。

## 依 context 用量自動交接

自動交接預設關閉。要啟用，建立 `<agentDir>/resume-handoff/config.json`，內容為 `{"enabled": true, "softThresholdPercent": 75, "hardThresholdPercent": 88}`。`agentDir` 是 pi 的 agent 目錄，除非設了 `PI_CODING_AGENT_DIR`，否則為 `~/.pi/agent`。省略百分比時預設為 75 與 88。設定無效時會停用此功能，並在 session 開始時顯示警告。extension 在 session 開始時讀取設定，因此變更要到下一個 session 或執行 `/reload` 才生效。自動交接只在 TUI 中運作。

回合完成時，extension 會讀取 context 用量。用量達到或超過硬門檻時，中止該次執行一次。未達硬門檻但達到或超過軟門檻時，每次執行傳送一則 steer 訊息，請模型完成目前步驟並結束回合。執行結束後用量仍在軟門檻以上時，extension 執行 `/resume-handoff auto`，生成交接檔案並開始新 session。你用 Escape 中止的執行永遠不會觸發交接。交接生成本身的執行不會被中斷。

門檻是最後一回合加上交接生成的預算，不是保證。context window 較小時請調低門檻。extension 不會改變 pi 自己的 compaction。要以交接取代 compaction，在 pi 設定中把 `compaction.enabled` 設為 `false`。此時 context 溢位會讓執行以錯誤結束。中止會把佇列中的訊息還原到編輯器。

## 測試

在 repository 根目錄執行 `npm test` 會跑 `test/` 裡的單元測試。`test/e2e/acceptance.mjs` 在 tmux 裡用真的 provider 跑真的 pi。執行方式為 `node extensions/resume-handoff/test/e2e/acceptance.mjs --provider <provider> --model <model>`。`extensions/annotation/test/e2e/tmux-handoff.sh` 檢查 annotation 的 client 會跟隨交接。
