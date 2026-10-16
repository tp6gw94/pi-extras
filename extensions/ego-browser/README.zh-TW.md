# Ego Browser

[English](README.md)

`ego_browser` 操作一個 Ego Lite TaskSpace。手動任務不需要分類器。自動任務由呼叫者提供有限的候選動作，Jev 只選一個候選 ID，不產生程式、selector 或輸入文字。這個 extension 也附帶 model-invoked 的 [ego-browser-tools skill](skills/ego-browser-tools/SKILL.md)。

## 工具契約

`schema.ts` 在 `{ "request": <Request> }` 外層之下定義 `begin`、`observe`、`act`、`run`、`finish`、`release` 的 Request 判別聯集。

- `begin` 接受 `space.attach` 數字或 `space.create` 名稱，回傳 task token。contract 固定目標、`allowedOrigins`、`allowedActions`、`text`、`evidenceDir`、`deadline` 與 `maxActions`。`text` 是字串 key 到輸入值的對照表。
- `observe` 保存原始 snapshot，選擇性執行 checks 及 screenshot。它不解析 Ego snapshot 格式。
- `act` 接受 navigate、click、fill、select、press。ref target 必須帶目前同頁的 observation ID，並在派發動作的同一 Ego round 比對該觀測的 documentId 與 URL。這不保證同一文件內任意 DOM 重繪後的 ref 身分。CSS 和 Ego semantic selector 可手動使用。fill 與 select 只接受 contract 的 `textKey`。
- `run` 接受至多 32 個候選、確定性 checks、動作與時間預算。候選是原生控制項的 CSS selector。fill 或 select 候選的目前控制項值若已等於 contract 中該 textKey 的文字，就不提供給分類器，也不會執行。手動 `act` 不受此限。每一步排除已無需處理的 fill 與 select 候選，問一次選擇，重新檢查、執行動作、等待條件，並在同一 CLI round 保存下一個觀測。DOM 變動回傳 stale，不重試。
- `finish` 需要目前通過 checks 的 reviewed observation。工具在同一 Ego round 重新檢查並只派發一次 finish。失敗的 check 不會派發 finish，重複呼叫也不會關閉 space 兩次。

`actionsUsed` 是整個任務的累計值。contract `maxActions` 限制整個任務，run 的 `budget.maxActions` 則限制該次 `run` 呼叫，從該次呼叫開始計算。navigate、fill、click、select、press 各消耗一個動作。

Checks 支援 visible、value、text、url。text 使用 rendered innerText，不把隱藏子節點的 textContent 當成可見結果。每項回傳 actual、expected 和 pass 或 fail。只有非空且全部通過的 checks 才能產生 `checks_passed`。DONE 只是重新檢查要求，不是成功證明。

每次結果包含 actionsUsed、classifierCalls、checks、observation、tracePath、mayHaveLateEffects 與 issues。模型 usage 也回傳給 Pi。失敗結果有 isError，structuredContent 仍包含報告。

`release` 只接受 `task`，釋放目前 executor 的本機 lease，不呼叫瀏覽器，也不關閉 space。contract 過期後仍可執行。忙碌任務回傳 `busy`。重複 release 不會動到新的 lease。停止的任務需 release，才不會阻擋下一個任務，但仍須先確認不確定的瀏覽器效果。

凍結任務可在剩餘 contract 時限內執行有界的 `observe`，仍受 ownership、dialog 與 origin 檢查限制。觀測不會解除凍結。`mayHaveLateEffects` 在觀測及 release 後仍保留。已 release 的任務拒絕瀏覽器工作。

`diagnostics` 保留結果路徑、階段、原生等待前取得的有界 `after` 實際檢查值，以及內層或傳輸錯誤。結果以原子方式發布。取消不會把已保存的成功提升成成功回報。導航與原生等待共用逐步遞減的 round 預算，手動操作的 30 秒上限不變。`text` 或 `value` check 的 actual 為 `null` 時，可能代表 selector 沒有匹配任何元素，請對照保存的 snapshot 檢查 selector。頁面標題不能證明 DOM 結構。診斷不會自動證明失敗原因。

```json
{
	"request": { "op": "release", "task": "<task token from begin>" }
}
```

## 執行與限制

Ego 是唯一 browser owner。每次呼叫建立 `ego-browser nodejs` 子程序，stdin 寫完立即關閉。沒有 Playwright、CDP、claim、takeover 或任意 JS 入口。CLI 子程序只繼承基本執行環境及 EGO 環境變數，不繼承模型金鑰。

任務只保留於目前 executor 記憶體，不跟隨對話分支回捲。active、frozen、finished、released 是明確生命週期。每個 space 使用跨程序 exclusive lease，不會搶走既有 lease。正常 session_shutdown 先停止受理、取消並等待全部已受理工作收尾，再釋放 lease，但不 finish。重複 shutdown 等待同一個清理工作。程序崩潰留下的 lock 需協調者確認原 executor 已退出及瀏覽器效果後處理，不會自動清除。

有可能已送出的 mutation 遭取消或發生錯誤時，任務凍結並回報 `uncertain_effect`。停止 CLI 或等待本機工作收尾不代表撤回瀏覽器動作。釋放 lease 也不保證沒有晚到效果，協調者必須確認瀏覽器效果後才開始新任務。不要重播、重載、關頁或另建 space。ownership、dialog、popup 或意外導向也停止執行。

`allowedOrigins` 會檢查導航目的地、可見 anchor 目的地與操作後 URL，但不是網路隔離。表單、redirect 或頁面 script 仍可能先送出網路請求。自動流程不支援 canvas、rich editor、自訂 widget、iframe 或 shadow DOM 控制項。自動動作採保守的整份 facts 比對，動態文字、屬性或 check actual 可能造成 stale。目前不放寬此限制。

原始 snapshot、check 證據與 trace 寫入 `evidenceDir`。截圖僅在要求時產生。這些檔案可能含頁面個資，不會自動上傳。

## 分類器設定

預設使用 Pi registry 的 `typesafe/jev-latest`。沿用 Pi 的 credential 解析，不另建 HTTP client。每次呼叫帶剩餘 timeoutMs、signal 與 maxRetries 0。沒有預設 confidence 門檻或校準宣稱。

`PI_EGO_CLASSIFIER_PROVIDER` 與 `PI_EGO_CLASSIFIER_MODEL` 可選擇已在 Pi 設定的 classifier。未來相容的 Kev provider 可使用相同入口，但這次沒有部署或測試 Kev。Jev 要有可用的 TYPESAFE_API_KEY。

## RPC 整合

以 user scope 安裝 pi-extras，rpc-subagents 的 child 才會沿用。rpc-subagents 載入已啟用的 user scope extension，並跳過 project scope extension，所以只裝於專案時，不可假設 child 自動載入 ego-browser。`--extension <absolute path>` 是手動啟動 Pi 程序時使用的 Pi CLI 參數；`rpc_subagents_run` 沒有 extension 設定欄位。

任務設定使用 `tools: ["read", "ego_browser"]` 及 `webAccess: false`。[rpc-subagents README](../rpc-subagents/README.md) 記載支援的任務設定。工具清單不是執行證據，驗收還要查看實際 invocation 和 result。父程序只讀保存的證據，不再連線同一瀏覽器。整份 contract 只由一個 executor 執行。

## 直接呼叫範例

工具參數永遠是物件 `{ "request": <Request> }`。範例使用 placeholder：真實 task token、observation ID 與 ref 來自先前的呼叫，evidence 目錄與 deadline 來自 contract。

```json
{
	"request": {
		"op": "begin",
		"space": { "create": "checkout-form" },
		"contract": {
			"goal": "Fill the form",
			"allowedOrigins": ["http://127.0.0.1:4317"],
			"allowedActions": ["navigate", "fill", "click"],
			"text": { "email": "test@example.invalid" },
			"evidenceDir": "/abs/evidence",
			"deadline": "2030-01-01T00:00:00Z",
			"maxActions": 12
		}
	}
}
```

`begin` 建立的 space 會停在所有 allowedOrigins 之外的新分頁，此時 `observe` 會回傳 `scope_violation` 並凍結任務。`begin` 之後請直接用 `navigate` act 前往允許的 URL（上面的 contract 已在 `allowedActions` 列出 `navigate`），act 回報會帶出下一步要讀的 observation。已 attach 且位於允許範圍內的頁面，在選擇元素前先 observe。

```json
{
	"request": {
		"op": "act",
		"task": "<task token from begin>",
		"page": "p1",
		"action": { "kind": "navigate", "url": "http://127.0.0.1:4317/" },
		"after": { "kind": "visible", "selector": "#email" }
	}
}
```

```json
{
	"request": {
		"op": "observe",
		"task": "<task token from begin>",
		"page": "p1",
		"checks": [
			{
				"id": "confirmed",
				"condition": { "kind": "text", "selector": "#confirmation", "includes": "Order confirmed" }
			}
		]
	}
}
```

```json
{
	"request": {
		"op": "act",
		"task": "<task token from begin>",
		"page": "p1",
		"observation": "<observation id from observe>",
		"action": { "kind": "fill", "target": { "ref": "ref=20" }, "textKey": "email" },
		"after": { "kind": "value", "selector": "#email", "equals": "test@example.invalid" }
	}
}
```

```json
{
	"request": {
		"op": "run",
		"task": "<task token from begin>",
		"page": "p1",
		"goal": "Fill email then submit",
		"candidates": [
			{
				"id": "email",
				"action": { "kind": "fill", "selector": "#email", "textKey": "email" },
				"after": { "kind": "value", "selector": "#email", "equals": "test@example.invalid" }
			},
			{
				"id": "submit",
				"action": { "kind": "click", "selector": "#submit" },
				"after": { "kind": "text", "selector": "#confirmation", "includes": "Order confirmed" }
			}
		],
		"checks": [
			{
				"id": "confirmed",
				"condition": { "kind": "text", "selector": "#confirmation", "includes": "Order confirmed" }
			}
		],
		"budget": { "maxActions": 3, "timeoutMs": 60000 }
	}
}
```

```json
{
	"request": {
		"op": "finish",
		"task": "<task token from begin>",
		"reviewedObservation": "<passing observation id>"
	}
}
```

## 離線驗證

從儲存庫根目錄執行下列命令。fake CLI 只實作記憶體與檔案中的 vendor boundary，不開瀏覽器。

```sh
node --test extensions/ego-browser/test/*.test.ts extensions/ego-browser/test/*.test.mjs test/package.test.ts
npm run typecheck
```

Registration 測試實際建立 Pi session，驗證 direct tool 可達及 unknown_task 錯誤結果。Skill 測試透過 Pi SDK 載入 extension，並用 `ToolParametersSchema` 驗證所有文件中的 request payload。runtime 測試執行 stdin EOF fake CLI，涵蓋 manual ref、原始 snapshot、false DONE、stale、cancel、ownership、lease 與 finish。

## 可重用 live harness

只供被授權的唯一 runtime executor 執行。`EGO_SPACE_ID` 必填，harness 只 attach 該 space 的 p1，不建立 space。其他頁籤與 profile 保持不變。

先啟動單一 fixture。它只綁定 127.0.0.1，預設 port 4317，可用 `PORT` 更改。

```sh
node extensions/ego-browser/test/fixture.mjs
```

另開終端機執行。`EGO_EVIDENCE_DIR` 可選，預設是 `extensions/ego-browser/test/.artifacts/live-模式-時間戳`。

```sh
export EGO_SPACE_ID=<authorized space id>
export EGO_EVIDENCE_DIR=<optional absolute evidence dir>
node extensions/ego-browser/test/live.ts <mode>
```

除 finish 與 ownership 外，每個模式先重設 fixture 並導航 p1，且成功標記初始必須不存在。

- `manual`：腳本化手動 fill、click、observe，是工具基準，不是大型模型規劃基準。
- `fake`、`done`：真實 Ego 加假分類器。done 必須零 mutation 且 `check_failed`。
- `jev`：真實 registry Jev，會產生模型費用。成功必須有一筆 order 且 email 相符。
- `ref`：由 observe 保存的真實 snapshot 取得 Email 欄位 textbox 的 `ref=N`，下一個 one-shot round 以該 ref 與 observation ID 執行 fill，再用 value check 驗證。接著用舊 observation ID 重送，必須回 stale。不送出訂單。
- `limit`：假分類器，run 的 `budget.maxActions` 為 1。必須在該次 run 的一個動作後回 `action_limit`，任務累計 actionsUsed 為 2，因為先前的 navigation 已消耗一個；server 零 mutation。
- `cancel`：fixture 把訂單延遲 4 秒接受。harness 在 fixture 收到請求後取消 click。必須 `uncertain_effect` 且 mayHaveLateEffects 為 true。之後輪詢 `/state` 記錄晚到效果，再重送 click 必須仍是 `uncertain_effect`，且 server received 與 mutations 都維持 1。不重試。
- `finish`：不重設也不導航。只 attach、對已知 `#confirmation` check 做 observe，通過後明確 finish。這是唯一會關閉 space 的模式，只能在最後一輪由獲授權者單獨執行。
- `ownership`：只 begin，必要時 observe。必須在其中一步得到 `ownership_lost`，且 actionsUsed 為零、沒有 act、run 或 finish 請求。仍為 agent-owned 不能驗收成功。只有另行獲准的使用者接管後才能執行，不會自動 claim 或 takeover。
- `hidden-text`：重設 fixture 並導航 `/?hidden-text=1`。可見的 Pending 容器內含 hidden、`display:none` 與 `visibility:hidden` 的成功文字。observe 必須回 fail 且 actual 為 Pending，finish 必須拒絕，server received 與 mutations 必須都是零。不點擊訂單、不呼叫分類器。

無論成功或失敗，每個模式都在丟出錯誤前寫入 `calls.json` 與 `summary.json`。summary 包含 ok、failure、reasons、errors、checks、actions、classifierCalls 與 fixture `/state` 的 server 結果。cancel 另含 stateAtAbort、stateAfterLateEffect、stateAfterRetryAttempt。harness 不讀 stdin，不會因等待核准而卡住。

fixture 的 `/state` 回傳 received（到達順序）、mutations 與 orders。orders 依實際接受順序排列並帶 seq 與 acceptedAt。`POST /delay?ms=N` 延遲之後訂單的接受，`POST /reset` 清空全部狀態。

## Runtime 狀態

離線測試通過。獲授權的 runtime executor 在授權 space 上跑過 live harness 模式直到 finish 與 hidden-text 停止條件，並由 child event log 的實際 `ego_browser` 呼叫驗證 RPC child invocation。`ownership` 模式需要獲准的使用者接管，尚未執行。Kev 未測試。不宣稱速度提升。
