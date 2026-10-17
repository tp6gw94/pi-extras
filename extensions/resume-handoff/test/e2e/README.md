# 驗收真實 Pi 交接

需要 Node.js 22、tmux、Pi 1.3.0 以上，以及可用的 provider 與 model。此測試會呼叫真實模型並產生費用。

在套件根目錄執行以下指令。將 provider 與 model 換成已安裝環境可用的值。

```sh
node extensions/resume-handoff/test/e2e/acceptance.mjs \
	--provider openai-codex --model gpt-6-astra --thinking low \
	--evidence /tmp/handoff-acceptance
```

每次執行都建立獨立的工作目錄、session 目錄、agent 設定目錄與 tmux server。`--pi PATH` 指定 Pi 執行檔。`--cwd EMPTY_DIR` 與 `--session-dir EMPTY_DIR` 可指定空目錄。`--timeout SECONDS` 設定每個等待條件的上限，預設為 180 秒。

腳本只載入交接 extension 與觀察事件的測試 extension。觀察者不產生模型回應，也不寫交接檔案。成功條件包括原 agent 實際寫入交接檔案、正常結束、新 session 的 parent 關聯、英文啟動訊息、第一個工具呼叫成功讀取精確路徑，以及接續工作寫出唯一 marker。出現審核或選檔對話會使驗收失敗。

另以 `--mode explicit` 執行既有檔案模式。

```sh
node extensions/resume-handoff/test/e2e/acceptance.mjs \
	--provider openai-codex --model gpt-6-astra --mode explicit \
	--evidence /tmp/handoff-acceptance
```

腳本從 `--auth-source AGENT_DIR` 複製 `auth.json` 與 `models.json` 至私有測試目錄。預設來源為 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`。環境中的 API key 也會繼承。腳本不修改全域設定或認證檔，不輸出認證內容，結束時刪除私有認證副本。需要額外 provider extension 的模型不在此腳本支援範圍。

證據保存在輸出指出的 `handoff-e2e-*` 目錄，包含 `command.json`、`version.txt`、`events.jsonl`、`terminal.txt`、session JSONL 與成功時的 `result.json`。若指定外部 session 目錄，JSONL 保留在該目錄。終端畫面與 session 內容只供本機驗收，分享前仍須檢查。

失敗或逾時會回傳非零狀態。腳本會關閉自己的 tmux server，不影響其他 server。生成失敗、中止、導覽與重複指令由自動化行為測試涵蓋，此腳本不宣稱完成那些真實 TUI 情境的驗收。
