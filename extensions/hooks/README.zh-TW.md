# pi-hooks

[English](README.md)

pi-hooks 是 [pi](https://github.com/earendil-works/pi) 的擴充套件，會在 agent 寫檔後 format 該檔案、在一輪結束前對這一輪改過的檔案跑 lint，並把錯誤送回給 agent 在同一輪裡修正。

設定寫在每個專案的 `.pi/hooks.json`。沒有這個檔案時，擴充套件什麼都不做。

pi-hooks 在 `@earendil-works/pi-coding-agent` 1.0.4、Node.js 22.19 以上測試過。hook 指令透過 `sh` 執行，所以 pi-hooks 以 Linux 和 macOS 為對象。Windows 未測試。

## 以 pi package 安裝

要在所有專案使用 pi-hooks，執行：

```sh
pi install git:github.com/tp6gw94/pi-hooks
```

只想裝在目前的專案，加上 `--local`。pi 會把套件寫進 `.pi/settings.json`：

```sh
pi install --local git:github.com/tp6gw94/pi-hooks
```

不安裝、只在一次 session 裡試用，就從 clone 下來的 repo 載入擴充套件檔案：

```sh
pi --extension ./hooks-pi/index.ts
```

## 5 分鐘設定 hooks

這個快速入門要在一個 TypeScript 與 Python 混合的專案裡加上 format 與 lint hook。TypeScript 檔案經過 prettier 和 eslint，Python 檔案經過 `ruff format` 和 `ruff check`，Markdown 檔案不跑任何 hook。

下面的指令與輸出來自一次真實執行，使用 pi 1.0.4 與 `openai-codex` 的 `gpt-5.5` 模型。`test/e2e/` 裡的腳本可以重建這個專案並重跑一次。

### 建立設定檔

先在專案裡安裝工具。pi-hooks 從專案根目錄執行每個指令，所以下面的路徑都相對於根目錄：

```sh
npm install -D prettier eslint @eslint/js typescript-eslint typescript
python3 -m venv .venv && .venv/bin/pip install ruff
```

接著建立 `.pi/hooks.json`：

<!-- example-config -->
```json
{
	"afterWrite": [
		{ "name": "prettier", "glob": "*.ts", "command": "node_modules/.bin/prettier --write {files}", "timeoutMs": 20000 },
		{ "name": "ruff format", "glob": "*.py", "command": ".venv/bin/ruff format {files}", "timeoutMs": 20000 }
	],
	"beforeSettle": [
		{ "name": "eslint", "glob": "*.ts", "command": "node_modules/.bin/eslint {files}", "timeoutMs": 60000 },
		{ "name": "ruff check", "glob": "*.py", "command": ".venv/bin/ruff check --no-cache {files}", "timeoutMs": 60000 }
	]
}
```

依這份設定，各種檔案會跑這些指令：

| 檔案 | 每次 `write` 或 `edit` 之後 | 一輪結束前 |
| --- | --- | --- |
| `src/math.ts` | `prettier` | `eslint` |
| `app/util.py` | `ruff format` | `ruff check` |
| `docs/notes.md` | 無 | 無 |

### 核可指令

在專案裡啟動 pi，給它一個會寫檔的任務。真實執行時，prompt 要求 agent 在同一輪寫出 `src/math.ts`、`src/greet.ts`、`src/legacy.ts`、`app/util.py` 和 `docs/notes.md`。其中兩個檔案故意帶有 lint 錯誤：`src/legacy.ts` 用了 `var`，`app/util.py` 有沒用到的 `import os`。

pi-hooks 第一次要執行某個專案的指令前，會先問你。你會看到這個對話框，路徑與 hash 會是你自己的：

```text
pi-hooks: run commands from this project?

/path/to/project/.pi/hooks.json (sha256 9783e0499a42) wants to run these shell commands:

after write  [*.ts]  node_modules/.bin/prettier --write {files}
after write  [*.py]  .venv/bin/ruff format {files}
before reply [*.ts]  node_modules/.bin/eslint {files}
before reply [*.py]  .venv/bin/ruff check --no-cache {files}

Allow? You will be asked again if the file changes.
```

選 yes。

### 看 format 與 lint 執行

每次寫檔後，pi-hooks 只對那一個檔案跑符合的 formatter。formatter 改動了檔案時，pi-hooks 會在 agent 讀到的 tool result 後面加一段說明：

```text
[pi-hooks] src/legacy.ts was reformatted by `prettier` after this write. Its content on disk now differs from what you wrote; re-read it before the next edit (edit needs exact text).
```

agent 準備結束這一輪時，pi-hooks 對三個 `.ts` 檔跑一次 `eslint`，對 `app/util.py` 跑一次 `ruff check`。兩個都失敗，你會看到這則通知：

```text
pi-hooks: checks failed; asking the agent to fix (attempt 1/3).
```

agent 會在一則 `pi-hooks` 訊息裡收到錯誤。以下是節錄：

````text
[pi-hooks] Checks failed on files you changed (automatic fix attempt 1 of 3). Fix the code so these checks pass, then finish your reply.
Do not edit .pi/hooks.json or otherwise disable, skip or weaken the checks; config changes only apply from the next user prompt anyway. If an error cannot be fixed in code, say so in your reply.

### `eslint` (exit 1) on src/greet.ts, src/legacy.ts, src/math.ts
```
/path/to/project/src/legacy.ts
  1:1  error  Unexpected var, use let or const instead  no-var
```

### `ruff check` (exit 1) on app/util.py
```
F401 [*] `os` imported but unused
 --> app/util.py:1:8
```
````

agent 讀了兩個檔案並修正，pi-hooks 再跑一次兩個檢查。真實執行時這段花了 7 秒。兩個檢查都通過時，你會看到這則通知：

```text
pi-hooks: checks pass after 1 fix attempt(s).
```

然後這一輪結束。`docs/notes.md` 沒有符合任何規則，所以沒有指令對它執行。

想看 pi-hooks 執行的每個指令，啟動 pi 前把 `PI_HOOKS_LOG` 設成一個檔案路徑。pi-hooks 每執行一個指令就加一行 JSON，內容有階段、規則、檔案、exit code、是否逾時與耗時。

## 設定參考

pi-hooks 從 pi 執行的目錄讀取 `.pi/hooks.json`。這個檔案是一個 JSON 物件，有這些 key：

| Key | 型別 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `afterWrite` | 規則陣列 | `[]` | 每次 `write` 或 `edit` 工具呼叫成功後執行的規則，包含 codemode 的巢狀呼叫。每條符合的規則只對那一個檔案執行。 |
| `beforeSettle` | 規則陣列 | `[]` | agent 準備結束這一輪時（`agent_before_settle`）執行的規則。每條符合的規則執行一次，對象是這一輪改過且符合其 `glob` 的所有檔案。 |
| `maxFixAttempts` | 0 以上的整數 | `3` | 一次使用者 prompt 之後，pi-hooks 最多要求 agent 修正失敗檢查的次數。 |
| `maxOutputChars` | 正整數 | `4000` | 送給 agent 的錯誤輸出上限。失敗的規則平分這個上限，但每條失敗的規則至少保留 500 個字元，所以失敗的規則超過 `maxOutputChars` / 500 條時（預設值下超過 8 條），總長度會超過 `maxOutputChars`。輸出太長時，pi-hooks 保留開頭與結尾。 |

每條規則是一個物件，有這些 key：

| Key | 型別 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `glob` | 字串或字串陣列 | 必填 | 規則適用的檔案。 |
| `command` | 字串 | 必填 | shell 指令。pi-hooks 從專案根目錄以 `sh -c` 執行。 |
| `timeoutMs` | 正數 | `afterWrite` 為 `30000`，`beforeSettle` 為 `120000` | 指令的時間上限，單位是毫秒。 |
| `name` | 字串 | `command` 的內容 | 通知與給 agent 的訊息裡顯示的名稱。 |

### `glob`

- 不含 `/` 的 glob 比對任何深度的檔名。`*.ts` 符合 `a.ts` 與 `src/deep/a.ts`。
- 含 `/` 的 glob 比對相對於專案根目錄的路徑。`src/**/*.ts` 符合 `src/a.ts` 與 `src/x/y/a.ts`。
- pi-hooks 支援 `*`、`**`、`?`、`[...]`、`[!...]` 與 `{a,b}`。
- 在陣列裡，以 `!` 開頭的 glob 排除前面 glob 已符合的檔案。`["*.ts", "!*.d.ts"]` 符合 `a.ts`，不符合 `types.d.ts`。

### `{files}`

pi-hooks 把 `command` 裡每個 `{files}` 換成符合的檔案，以空白分隔。每個路徑都相對於專案根目錄，並已為 `sh` 加上引號。以 `-` 開頭的路徑會加上 `./` 前綴，所以名為 `--fix.ts` 的檔案會以 `./--fix.ts` 傳給工具，不會被當成選項。沒有 `{files}` 的指令照原樣執行。

### 改過的檔案

每次使用者 prompt 開始時，pi-hooks 把工作目錄寫成一個 git tree 物件。它用的是 index 的暫時副本，所以你的 index 與 staged 變更不會改變。agent 準備結束這一輪時，pi-hooks 再拍一次快照並比較兩者。新增與修改的檔案算在內，刪除的不算。agent 用 `bash`、`sed` 或程式碼產生器改的檔案也算。

專案不是 git repository 時，pi-hooks 改用這一輪 `write` 與 `edit` 呼叫的路徑。

### 錯誤與逾時

- `.pi/hooks.json` 有錯時，pi-hooks 警告一次，略過有問題的規則，其餘照常載入。
- 指令執行超過 `timeoutMs` 時，pi-hooks 終止它整個 process group 並通知你。行程一直不結束時，pi-hooks 在時間上限過後 7 秒停止等待。
- lint 逾時只通知你，不送給 agent。formatter 失敗或逾時也只通知你。
- agent 修正 `maxFixAttempts` 次後檢查仍失敗時，pi-hooks 停止，把剩下的錯誤顯示給你，並加進對話但不要求 agent 繼續。次數在下一次使用者 prompt 時歸零。

## 安全性

`.pi/hooks.json` 是 repository 的一部分。clone 一個 repository 後，它的 hook 可以在你的機器上執行任何指令。pi-hooks 用這些方式保護你：

- 第一次執行某份設定裡的指令前，pi-hooks 列出所有指令並請你核可。
- pi-hooks 把每份核可過的設定的 SHA-256 hash 存在 `~/.pi/agent/pi-hooks-trust.json`，以設定檔的絕對路徑為 key。檔案一改，pi-hooks 就再問一次。
- 你拒絕時，pi-hooks 不執行那份設定，且在同一個 pi session 裡不再詢問。
- pi-hooks 在每次使用者 prompt 開始時讀一次設定，整輪都用那一份。agent 為了讓檢查通過而改 `.pi/hooks.json` 時，修改在這一輪不生效，pi-hooks 會警告你。新設定要等你核可後，從下一個 prompt 開始套用。曾有一次真實執行中，`gpt-5.5` 真的改了設定來繞過失敗的檢查，這條規則因此而來。
- print 模式（`-p`）與 JSON 模式無法顯示對話框。在這兩種模式下，pi-hooks 不執行你沒核可過的設定。要核可設定，先用互動模式或 RPC 模式執行一次 pi。

## 限制

- 寫檔後 format 只在 `write` 與 `edit` 工具之後執行。agent 用 `bash` 改檔案時，不會有 formatter 對它執行。一輪結束前的 lint 仍會檢查它。
- agent 的第一則回覆會在 lint 之前出現。檢查失敗時，agent 修正程式碼後會再寫第二則回覆。
- 每次修正後，pi-hooks 對這次 prompt 以來改過的所有檔案重跑檢查，不只修正過的檔案。在預設 3 次修正的上限下，一個檢查每次 prompt 最多跑 4 次。
- 因為你中斷或因為錯誤而結束的一輪，pi-hooks 不跑 lint。
- pi-hooks 從 pi 執行的目錄讀取 `.pi/hooks.json`，不是從 git 根目錄。
- 逾時時，pi-hooks 需要 `setsid` 才能終止指令的子行程。Linux 有 `setsid`。沒有 `setsid` 時（例如預設的 macOS），pi-hooks 只終止主行程，子行程可能繼續執行。

## 開發

```sh
npm install
npm run typecheck
npm test
```

`npm test` 執行單元測試。要用真實模型跑端對端情境，使用 `test/e2e/acceptance.sh`：

```sh
test/e2e/acceptance.sh /tmp/pi-hooks-e2e -- --provider openai-codex --model gpt-5.5
```
