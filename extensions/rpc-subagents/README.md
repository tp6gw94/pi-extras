# RPC subagents 使用指南

這份指南供已使用 Pi、想管理子代理任務的使用者閱讀。此擴充功能在主 Pi 程序內管理獨立的 `pi --mode rpc` 子程序，沒有 SDK 執行或備援。

已實測同步與背景任務、codemode chain 與平行、一般 fork、排程觸發與中止，以及同行程 fleet UI。Herdr 可開啟執行中任務的唯讀 viewer，重播並追蹤同一份 RPC 事件，第二次開啟會重用 pane 且不搶焦點。本文件不重複列出可能過期的測試總數。

## 載入擴充功能

rpc-subagents 隨 pi-extras 套件安裝與載入，安裝方式見 [pi-extras README 的安裝說明](../../README.zh-TW.md#安裝)（[English](../../README.md#install)）。cron 需要的 `croner@9.1.0` 由套件一併安裝。

1. 安裝或更新套件後，在主 Pi 執行 `/reload`。此操作會中止舊 runtime 的 RPC 任務，再載入排程。
2. 執行 `/rpc-subagents` 開啟任務與排程清單。

TUI 的即時輸出預覽預設收合；按 `Ctrl+O` 可展開或再次收合，同時保留 Pi 原本的工具輸出展開／收合功能。也可執行 `/rpc-subagents-output` 單獨切換子代理預覽。最多預覽三個進行中的任務，每個顯示保留文字的尾端約四行，依終端高度縮減；沒有進行中任務時，僅在展開狀態顯示最近結束的任務。內容已達保留上限時會標示截短，完整輸出請開啟 viewer。`/reload` 後恢復收合。

若目前沒有啟用 codemode，可用一次性的 CLI 選項啟動 Pi，不需改既有設定。

```sh
pi --tools read,bash,edit,write,codemode,rpc_subagents_run,rpc_subagents_status,rpc_subagents_result,rpc_subagents_wait,rpc_subagents_cancel,rpc_subagents_respond,rpc_subagents_pending,rpc_subagents_reply,rpc_subagents_steer,rpc_subagents_view,rpc_subagents_schedule_create,rpc_subagents_schedule_list,rpc_subagents_schedule_pause,rpc_subagents_schedule_resume,rpc_subagents_schedule_cancel
```

`--tools` 是完整 allowlist，漏列的 extension 工具連 codemode 都無法呼叫。上面列出全部 15 個名稱，不含只存在於 child 的 model-only `rpc_subagents_parent`。若你的既有設定已用 `defaultTools: ["+codemode"]` 啟用 codemode，直接執行 `pi` 即可保留預設與 extension 工具；本擴充功能不修改設定。

擴充功能只註冊 `rpc_subagents_*` 工具，全部使用 `exposure: "codemode"`。它不更動主 session 的 active tools。

## 儲存位置與舊版資料路徑

資料與設定放在 pi 的 agent 目錄（`getAgentDir()`，預設 `~/.pi/agent`，可由 `PI_CODING_AGENT_DIR` 改變）下的 `rpc-subagents/`，不放在擴充功能或套件目錄內，因此重新安裝或更新 pi-extras 不會動到它們。

| 路徑 | 內容 |
| --- | --- |
| `<agentDir>/rpc-subagents/data/` | runtime 資料：tasks、projects、schedules、templates、session catalog |
| `<agentDir>/rpc-subagents/config.json` | 選用的本機設定 |
| `<agentDir>/rpc-subagents/migration.json` | 從舊位置複製的紀錄（來源、目的與時間） |

舊版把這些檔案放在擴充功能目錄 `<agentDir>/extensions/rpc-subagents/`（`data/` 與 `config.json`），更早的版本則用 `<agentDir>/extensions/rpc-fleet/data`。第一次需要 runtime 時（主 Pi 的 `session_start`），若新位置沒有資料，而舊位置有，擴充功能會把舊資料複製一次到新位置；兩個舊位置都有資料時，沿用舊版的優先順序，取 `rpc-fleet/data`。`config.json` 獨立判斷：新位置沒有 `config.json` 而舊位置有時才複製。複製時：

- 受管理 session、session catalog、session lease、schedule template 與 task 狀態裡指向舊資料目錄的絕對路徑改為新目錄，catalog 依新路徑重新命名，原本吻合的檔案識別也一併更新，舊的 session 可繼續接續，fork 排程可繼續觸發。事件記錄與 session 內容逐位元組複製。
- 舊 `config.json` 裡 `providerSources` 的相對路徑原本以舊擴充功能目錄為基準，複製時改為絕對路徑，指向原本的位置。
- 先複製到暫存目錄再改名，失敗時不留下部分資料，也不寫入 `migration.json`；主 Pi 在 TUI 顯示排程未啟動的警告。
- 舊位置的檔案不修改、不刪除。確認新位置正常後可自行刪除。

複製完成後寫入 `migration.json`，之後只讀寫新位置；即使之後刪除新位置的資料，也不會再次複製。新位置已有資料時不複製，也不讀取舊位置。在 TUI 中，複製完成時會顯示一次通知。

## 載入 agent 操作 skill

擴充功能透過 `resources_discover` 提供內附的 [rpc-subagents skill](skills/rpc-subagents/SKILL.md)。主 Pi 啟動或 `/reload` 後會將名稱與觸發描述加入可用 skills，agent 在操作 RPC 任務、排程或 viewer 時按需讀取。

需要明確載入時，執行 `/skill:rpc-subagents`。不需修改設定或另外安裝 skill。此 skill 供主代理使用，RPC child 不會繼承它。

## 找到工具

在 codemode 執行下列程式。

```js
text(await searchTools("rpc_subagents", { namespace: "rpc_subagents" }));
text(await describeTool("rpc_subagents_run"));
text(await describeNamespace("rpc_subagents"));
```

## 串接同步任務

同步是預設行為。工具等待 `agent_settled`，再回傳包含 `status`、`text` 與 `taskId` 的物件。`agent_end` 或 prompt 接受回應都不是完成訊號。

```js
const first = await tools.rpc_subagents_run({
	name: "Review",
	prompt: "Review the current project and summarize the main risks.",
	context: "fork"
});
if (first.status !== "completed") throw new Error(first.error ?? first.status);
const second = await tools.rpc_subagents_run({
	name: "Checklist",
	prompt: `Turn these findings into a short checklist: ${first.text}`,
	context: "fresh"
});
return { first: first.taskId, status: second.status, text: second.text };
```

省略 `model` 時，擴充功能擷取目前 `ctx.model` 的 provider 與 ID，明確傳給 child。你也可以傳入 `model: { provider: "<provider>", id: "<exact-model-id>" }` 與 `thinking: "high"`。child 必須回報相同模型及支援的 thinking level，否則任務失敗，不使用其他模型或 SDK fallback。

## 平行執行

所有任務共用指定的 `cwd`。平行寫入同一檔案會發生碰撞。此擴充功能不建立 worktree，也不鎖住專案檔案。

```js
const results = await Promise.allSettled([
	tools.rpc_subagents_run({ name: "Tests", prompt: "Inspect test coverage without editing files." }),
	tools.rpc_subagents_run({ name: "API", prompt: "Inspect public API consistency without editing files." })
]);
return results;
```

## 執行背景任務

`async: true` 在本機佇列接受任務後立即回傳 ID。回傳 `queued` 不代表 child 已完成啟動或 provider 已成功接受 prompt。任務進入 terminal 狀態（`completed`、`failed`、`cancelled`、`interrupted`）時，主 Pi 會收到一次 follow-up 喚醒，訊息只帶 taskId 與狀態；主代理再用 `rpc_subagents_result` 讀取結果。排程觸發的任務不會喚醒主 Pi。需要在同一次呼叫內取得結果時，仍可用 `status` 或 `wait`。

```js
const task = await tools.rpc_subagents_run({
	name: "Background review",
	prompt: "Inspect the project and report issues without editing files.",
	async: true,
	timeoutMs: 1800000
});
store("reviewTask", task.taskId);
return { taskId: task.taskId, status: task.status };
```

```js
const taskId = load("reviewTask");
const result = await tools.rpc_subagents_wait({ taskId, timeoutMs: 60000 });
return { taskId, status: result.status, text: result.text };
```

`rpc_subagents_wait` 的期限只限制這次等待，不取消背景任務。codemode 結束或中止等待也不停止刻意分離的背景任務。同步 `run` 的 AbortSignal 則會取消 child，完成有限期限的程序清理後才結束呼叫。

## 切換 session 時保留任務

在同一個 Pi 程序內，`new`、`resume`、`fork`（包含 `/resume-handoff auto` 建立的新 session）會保留背景與排程任務。新 session 沿用原本的 fleet、task ID、child 程序、session leases 與排程 owners，不重新啟動任務。跨 cwd 的 `/resume` 也沿用同一份 fleet；新 session 必須仍載入此擴充功能。

切換時移除舊 widget，新 session 重新安裝 widget。TUI 會通知接續的進行中任務數量、ID、名稱與狀態。原本已追蹤、在切換空窗完成的背景任務會把完成通知補到新 session；仍待回答的 child ask 也會重新通知一次。這些補發訊息不自行啟動 agent turn，之後的新事件仍依原本規則喚醒。已送到舊 session 或已由工具讀到 terminal 狀態的完成結果不重播。

以真實 RPC 程序驗證切換行為時，執行 `node extensions/rpc-subagents/test/e2e/replacement.mjs --provider <provider> --model <model> --evidence /tmp/pi-extras-fleet-survival/e2e-dev`。
腳本會把 RPC 事件寫到 `<evidence>/events.jsonl`、摘要寫到 `<evidence>/summary.json`，全部斷言通過時 exit 0。

`/resume-handoff auto` 的生成提示會要求列出進行中任務的 ID、用途與 `rpc_subagents_result` 讀取方式；待回答的問題則列出 `rpc_subagents_pending` 與 `rpc_subagents_reply`，不為了交接等待或取消任務。

已知限制：

- `/reload` 與退出 Pi 仍會中止任務並清理資源，不保留到下一個程序。
- 同步 `rpc_subagents_run` 會在 `session_shutdown` 之前被 Pi 的 `session.abort()` 取消；保留範圍只有背景與排程任務。
- 若新 runtime 沒有載入此擴充功能，例如新 cwd 停用了它，fleet 會保持未綁定。children 繼續執行，但不喚醒任何 session，退出時也沒有 handler 能正常清理它們；程序結束才關閉管線。
- 此行為依賴 Pi loader 在同 cwd 重用快取 factory、並於同一 Node 程序更換 session 的現行實作，不是 Pi 公開保證的契約。Pi 文件建議跨 replacement 只保存 plain data。

## 指定子任務工具

`tools` 控制 child 的能力。純名稱會完整取代預設執行工具清單 `read`、`write`、`edit`、`bash`、`codemode`；`+名稱`／`-名稱` 則按順序調整同一份預設清單，兩者不能混用，也不能使用 `*` 等萬用字元。`[]` 表示不提供執行工具。可選的內建執行工具還包括 `grep`、`find`、`ls`。`rpc_subagents_parent` 由 child 端另外以 model-only 加入，不受 `tools` 影響。

```js
const task = await tools.rpc_subagents_run({
	name: "Read-only review",
	prompt: "Inspect the API without edits. Report concrete risks.",
	tools: ["+bash", "-codemode"]
});
return task;
```

在 `tools` 中指名已安裝的 pi-web-access 工具時，會自動載入網路支援，而且只開放指名的功能工具：`web_search`（搜尋網路）、`source_check`（查核宣稱與來源）、`fetch_content`（抓取頁面或文件內容）、`get_search_content`（讀取已保存的結果內容）。`web_enable` 是 child 在 auto／dynamic 模式下的啟用機制，不能直接選取。重新命名或停用的工具依安裝設定處理：指名已停用或已改名的舊名稱會明確失敗，使用目前名稱則成功。

```js
const fetched = await tools.rpc_subagents_run({
	name: "Fetch docs",
	prompt: "Fetch https://example.com and quote the heading.",
	tools: ["+fetch_content"]
});
const renamed = await tools.rpc_subagents_run({
	name: "Read-only fetch",
	prompt: "Read src and fetch the linked spec.",
	tools: ["read", "get_page"]
});
return [fetched.webTools, renamed.webTools];
```

`+fetch_content` 保留五個預設執行工具並只加入該網路工具；純名稱 `["read", "get_page"]` 則把執行工具換成 `read`。回傳的 `webTools` 是解析後的網路工具清單。

省略 `tools` 時，會提供五個預設執行工具與所有已啟用的網路工具。明確提供 `tools` 時，只啟用指名的網路工具；`[]` 不提供執行工具或網路工具。

啟用時只載入已安裝的本機 `pi-web-access` 入口，不下載、安裝套件或開啟其他 extension。沿用既有設定與繼承的憑證；支援 `auto`、`dynamic`、`eager`、重新命名及停用工具。若有可用的 `web_enable`，child 依其 prompt 指示啟用，且只能啟用被選取的功能工具；eager 模式不要求 loader。`capabilities.webTools` 列出解析後的網路工具，`active`／`reachable` 在啟用後更新。套件、入口、factory 缺失或全部工具停用時，任務明確失敗，不宣稱可用。`--tools` 只包含執行工具、parent，以及被選取的功能工具與必要的 loader，parent 仍拒絕其他額外可呼叫工具。

這只是工具清單，不是沙箱。child 與主程序同權限，仍可能依 prompt 指示或其他路徑碰觸檔案。需要隔離時請自行限制工作目錄與指令。排程會保存解析後的執行工具與網路工具，觸發時沿用，不會重新解讀 `+`／`-` 表示式，包含 `[]`。

### `safe-pi` 與 append-path

子程序直接以 Node 啟動目前安裝的 Pi CLI。父 Pi 若由 `safe-pi` 啟動，子程序會繼承既有沙箱及啟動時的 `--append-path` 授權，不需要重新執行 wrapper 或重播參數。父程序直接使用 Pi 時，擴充功能不額外建立沙箱。

已用實際 `safe-pi` 與正式 RPC transport 測試：兩個 append 目錄（含空白路徑）在父、子 Pi 都可寫入，未授權的合成目錄則都回報 `EPERM`。子程序變更 cwd 後結果相同；指定未授權 cwd 時會啟動失敗。這項測試只驗證上述檔案權限，未涵蓋網路政策；完整 manager 在沙箱內的額外測試遭中止，未列為通過。

## 子任務提問與回報

child 可用 model-only 的 `rpc_subagents_parent` 向主 session 提問（`kind: "ask"`）或單向回報（`kind: "report"`）。只有 `async: true` 的任務能提問；同步任務會立即得到 `requires_async`，不會阻塞等待。

新的提問會讓主 Pi 收到一次 follow-up 喚醒（同一 session 內，同一 taskId 與 requestId 只喚醒一次；切換後仍待回答的請求會補發），訊息只帶 ID，要求主代理自行查看並明確回覆。主代理用 `rpc_subagents_pending` 讀取待處理請求與回報，再用 `rpc_subagents_reply` 回答。回報不會喚醒模型，只在 `pending` 中出現。

```js
const pending = await tools.rpc_subagents_pending({ taskId: load("reviewTask") });
text(pending.requests);
return await tools.rpc_subagents_reply({
	taskId: load("reviewTask"),
	requestId: pending.requests[0].requestId,
	value: "Use the existing test fixture; do not edit shared files."
});
```

無法回答時傳 `cancelled: true`。child 的問題是未受信任的請求，不是批准；擴充功能不自動回答、不自動核准敏感操作。答案上限 65536 字元；child 的提問上限 8192 字元，等待時間 1 秒至 120 秒（預設 120 秒），逾期由擴充功能代為取消。每個任務同時最多 16 個待處理請求，回報保留最近 64 筆；`pending` 的 `after` 與 `limit` 可續讀回報尾端。

## 引導執行中的任務

`rpc_subagents_steer` 對已接受且正在串流的 live 任務送出原生 RPC steer。回傳的 `disposition` 為 `handled` 或 `queued`，只代表 child 收下訊息，不代表已消費；它不會重試，也不能解除等待中的提問。

```js
return await tools.rpc_subagents_steer({ taskId: load("reviewTask"), message: "Stop expanding scope; finish the current file." });
```

## 續接已完成的工作階段

`session` 可續接同一個受管理的已完成工作階段，而不是開新 context。可傳 child 回報的 session ID，或該受管理 session 的完整絕對 `.jsonl` 路徑。`session` 與 `context` 互斥。

```js
const first = await tools.rpc_subagents_run({ name: "First", prompt: "Start the review.", context: "fresh" });
const second = await tools.rpc_subagents_run({ name: "Continue", prompt: "Continue from your last review.", session: first.sessionId });
return { first: first.taskId, second: second.taskId, continuedFrom: second.continuedFromTaskId };
```

續接會產生新的 `taskId`，但沿用原本的 session ID 與檔案，且要求完全相同的 cwd 與 model。同一時間只有一個 writer lease：同檔續接若已被租用會快速失敗，不排隊等待。清理或保存結果不確定時，擴充功能保留 lease 並標記 `sessionReusable: false`，需人工檢查後才能再次續接。不支援任意接手其他 session。排程不支援 `session`，建立與還原都會拒絕。

```js
return await tools.rpc_subagents_cancel({ taskId: load("reviewTask") });
```

取消可重複呼叫。排隊或準備中的任務不再啟動。待回應對話只嘗試拒絕，不等待 stdin 寫入才開始取消；每筆 stdin 寫入（含佇列等待）最多 1 秒。執行中的任務先嘗試送出 `clear_queue`、`abort`，再關閉 stdin，必要時升級為 SIGTERM 與 SIGKILL。

## 回應子程序對話

child 完成啟動後若提出 `confirm`、`select`、`input` 或 `editor`，任務會顯示 `waiting_input`。擴充功能不自動核准。

目前安裝路徑 0.99.2（manifest 1.0.0）的 Pi RPC 仍先等待 `session_start`，再安裝 stdin reader。因此 **provider 在 `session_start` 等待使用者對話的啟動流程不受支援**：即使送出回應，Pi 也尚未讀取；啟動 handshake 最多 30 秒後失敗並終止 child，總任務期限若較短則更早失敗。請使用不需啟動期對話的 provider。只有啟動後的對話支援明確回應，不自動核准、不改走 SDK。

在 `/rpc-subagents` 選取任務，按 `r` 顯示原始請求。也可以先讀取 `rpc_subagents_status` 的 `state.dialogs`，再明確回應其 ID。

```js
return await tools.rpc_subagents_respond({
	taskId: "<task-id>",
	dialogId: "<pending-dialog-id>",
	cancelled: true
});
```

確認對話使用 `confirmed: true` 或 `false`。其他對話使用 `value`，`select` 的值必須是原始選項之一。未回應的對話最多等待 120 秒，之後送出匹配 ID 的取消回應。child 自訂的較短 timeout 仍有效。非互動環境也使用同樣的拒絕政策，不留下不可見的無限等待。

`rpc_subagents_respond` 只處理一般 UI 對話，`dialogId` 必須來自 `state.dialogs`。協調請求使用 `state.requests` 的 `requestId` 與 `rpc_subagents_reply`；把協調 requestId 傳給 `rpc_subagents_respond` 會被拒絕。任務只有協調請求、沒有一般對話時，`/rpc-subagents` 的 `r` 仍可顯示請求內容（已去除終端控制序列）並送出回答，取消則送出 `{cancelled:true}`；一般對話與協調請求同時存在時，`r` 先處理一般對話。

## 建立排程

`rpc_subagents_schedule_list` 只讀既有 owner 或磁碟快照；查詢另一個 cwd 不取得 lock、不啟動 timer、不修改資料。`session_start` 與明確排程管理操作才啟動該 cwd 的 owner。

排程只在有主 Pi owner 的時候執行。建立時間的 fork 是不可變範本，每次觸發再建立新的 child session。後來的主 session 對話不會改變範本。

```js
const schedule = await tools.rpc_subagents_schedule_create({
	name: "Later review",
	task: {
		name: "Scheduled review",
		prompt: "Review the captured context and summarize the remaining work.",
		context: "fork"
	},
	trigger: { type: "at", at: "+10m" }
});
store("reviewSchedule", schedule.scheduleId);
return schedule;
```

定期排程把 `trigger` 改為 `{ type: "interval", every: "30m" }`。cron 使用五個欄位，並明確指定 IANA 時區。

```js
return await tools.rpc_subagents_schedule_create({
	task: { prompt: "Inspect the project and report its current test status." },
	trigger: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Taipei" }
});
```

一次性絕對時間需要 `Z` 或 UTC offset，例如 `2027-01-01T09:00:00+08:00`。每個排程只能有一種 trigger。

```js
const scheduleId = load("reviewSchedule");
await tools.rpc_subagents_schedule_pause({ scheduleId });
await tools.rpc_subagents_schedule_resume({ scheduleId });
return await tools.rpc_subagents_schedule_cancel({ scheduleId, abortRunning: true });
```

`pause` 不停止既有任務。`cancel` 不復活排程。`abortRunning: true` 只取消該排程自己的 active task IDs。在互動畫面的排程頁，`p` 暫停或恢復，`c` 只取消未來觸發，`a` 取消並中止既有任務。

排程任務不支援 `session`：建立時在取得 owner 前即拒絕，還原持久化資料時也會 fail closed。排程保存解析後的執行與網路工具選取，觸發時沿用。

重新載入後，過期的一次性排程標記為 `missed`。重複排程只安排嚴格晚於現在的觸發，不補跑離線期間的工作。同一排程若已有排隊或執行中的任務，略過當次觸發。

## 開啟唯讀檢視器

在 Herdr 中執行 `/rpc-subagents-view <task-id>`，或在任務清單按 `v`。檢視器以獨立 Node 程序重播並追蹤該任務的 `events.jsonl`，不重新執行模型。

Herdr opener 要求 `HERDR_ENV=1`。它保存呼叫者的 `HERDR_PANE_ID`，只在身分未改變時使用已查驗的 `pane split --current ... --no-focus`。不省略 target，不追隨 UI 焦點，也不關閉其他 pane。已建立且仍存在的 pane 才能重用。

自動右側或下方分割讀取 `pane layout --pane <saved-id>` 回應中的 `result.layout.panes[]`，以 `pane_id` 找到呼叫者並使用 `rect.width`／`rect.height`；亦相容舊的 geometry 格式。此形狀與 opener 已在 Herdr 0.9.3 實測，首次回傳 `opened`，再次開啟同一任務回傳相同 pane ID 與 `reused: true`。若自動判斷失敗，可明確選擇方向，仍不得指定另一個未查驗的 caller。

```js
return await tools.rpc_subagents_view({ taskId: "<task-id>", direction: "right" });
```

opener 不可用時，回傳 `status: "unavailable"`、原因與已 quote 的獨立 viewer 指令。在一般終端執行該指令即可看同一份記錄。關閉 viewer 不會取消任務。較早超過 1 MiB 的記錄會顯示略過提示。viewer 會移除 terminal escape、控制字元及跨 delta 分段的 escape sequence；大型結果或記錄額度耗盡仍有小型終端標記，尾段略過大型終端事件時也會讀取 state.json 確認完成後結束。

## 加入額外 provider bootstrap

這些 bootstrap 來源必須能在不等待啟動期使用者對話的情況下完成 `session_start`。

child 會自動載入你自己的 extension，所以主 pi 能用的 provider（例如 DeepInfra）在 child 裡也能用，不必寫 `providerSources`。每次啟動 child 時，主程序都用 pi 的 `DefaultPackageManager` 與 `SettingsManager` 重新解析一次清單（不安裝缺少的套件），所以改完設定後，下一個 child 就會套用：

- 載入：個人設定 `settings.json` 的 `packages` 裡、依各套件的 extension 篩選後仍啟用的 extension，以及 `<agentDir>/extensions/` 裡的 extension。
- 不載入：專案範圍（cwd 的 `.pi/`）的 extension 與套件、被篩選或停用的 extension。
- 一律排除 pi-extras 的 `rpc-subagents`、`annotation`、`ux`、`hooks`（依套件 `package.json` 的 `name` 為 `pi-extras` 加上 extension 子資料夾名稱判斷）。pi-extras 的其他 extension（例如 `ralph`、`resume-handoff`）照常載入。
- 若 pi-extras 以 symlink、複本或其他套件名稱安裝，名稱比對不到，實際路徑落在本擴充功能目錄內的項目會被略過，並在 TUI 顯示一次通知，不會讓 child 啟動失敗；其他 pi-extras extension（含 `annotation`）此時會載入。即使本擴充功能仍被載入到 child，它偵測到 child 環境變數就什麼都不註冊，只有 child bridge 運作。

另外，若 agent 目錄有 npm 安裝的 `npm/node_modules/pi-claude-bridge`，也會加入。child 仍使用 `--no-extensions --no-skills --no-prompt-templates`，上面的清單、child bridge，以及任務啟用網路能力時的受控 web wrapper 都以明確的 `--extension` 傳入。

若需要上面清單以外的 provider（例如只放在某個專案的 extension），參考本目錄的 `config.example.json` 建立 `<agentDir>/rpc-subagents/config.json`。在指定 canonical cwd 的 `providerSources` 加入本機路徑。相對路徑以 `config.json` 所在的 `<agentDir>/rpc-subagents/` 為基準。`providerSources` 是額外清單，與自動清單依實際路徑去重；擴充功能不安裝來源，也不修改使用者設定。若 `providerSources` 指向本擴充功能目錄本身，仍會報錯。`providerSources` 裡的路徑不存在時，任務不會啟動，錯誤訊息為 `Provider bootstrap source does not exist: <路徑> (from providerSources of <cwd> in <config.json 路徑>)`；請修正該路徑，或從該 cwd 的 `providerSources` 移除它。

## 執行靜態與單元檢查

在 pi-extras 的 repo 根目錄執行：

```sh
RPC_SUBAGENTS_PI_PACKAGE=/absolute/path/to/@earendil-works/pi-coding-agent npm test
npm run typecheck
RPC_SUBAGENTS_PI_PACKAGE=/absolute/path/to/@earendil-works/pi-coding-agent \
  node extensions/rpc-subagents/test/typecheck.mjs
```

型別檢查需要 PATH 上已有 `tsc`，只讀取指定 Pi 的宣告檔，不執行 Pi。指定 `RPC_SUBAGENTS_PI_PACKAGE` 的測試會使用該安裝的純 context projection 與 TUI 寬度工具，不建立 Pi session 或執行模型。未指定 package 時這些測試明確略過；cron DST 測試在缺少依賴時明確略過。測試使用假 RPC process 與可控時計，不呼叫 provider API 或 Herdr CLI。
