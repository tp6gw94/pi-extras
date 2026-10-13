# pi-extras

[English](README.md)

pi-extras 是一個 [pi](https://github.com/earendil-works/pi) 套件，裡面有八個 extension。安裝一次，pi 就會載入其中每個 extension。你可以在 pi 的設定裡關掉個別的 extension。

pi-extras 在 `@earendil-works/pi-coding-agent` 1.0.4 與 1.1.0、Node.js 22 上測試過。

## Extension 列表

| Extension | 用途 | 文件 |
| --- | --- | --- |
| `annotation` | 用 `/annotate` 在瀏覽器打開對話的即時頁面，引用段落並加上筆記，再附加到編輯器；再執行一次 `/annotate` 就會停止。 | [Annotation](#annotation) |
| `hooks` | 依 `.pi/hooks.json`，在 agent 寫入檔案後格式化，並在回合結束前 lint 改過的檔案。 | [README](extensions/hooks/README.zh-TW.md) |
| `inline-skills` | 在 prompt 中間用 `/` 選 skill，送出時附上 skill 的路徑。 | [README](extensions/inline-skills/README.md) |
| `ralph` | 用 `/ralph` 對同一個任務跑有上限的多輪全新 pi session，用 `/ralph-stop` 停止。 | |
| `resume-handoff` | 用 `/resume-handoff` 從檢查過的交接檔案開新 session。 | |
| `rpc-subagents` | 以 `pi --mode rpc` 子程序執行子代理任務與排程，用 `/rpc-subagents` 列出它們。資料與 `config.json` 放在 `~/.pi/agent/rpc-subagents/`。 | [README](extensions/rpc-subagents/README.md) |
| `skill-name-normalizer` | `~/.pi/agent/skills` 與 `~/.agents/skills` 裡的 skill 名稱不合規時，給它一個合規的名稱。 | |
| `ux` | 把上一則 prompt 釘選在編輯器上方。 | [README](extensions/ux/README.zh-TW.md) |

每個 extension 放在 `extensions/<名稱>/`，測試與它附帶的 skill 也在同一個目錄。

## Annotation

`/annotate` 會在瀏覽器裡打開目前對話的即時頁面，讓你引用其中的段落並加上筆記。它不會卡住 pi；頁面開著的時候你可以繼續工作，新的訊息會即時出現在頁面上。

1. 執行 `/annotate`。pi 會為這個 session 啟動一個小伺服器，印出像 `http://127.0.0.1:4747/<session id>#t=<token>` 的網址，並在 macOS 用 `open`、在 Linux 用 `xdg-open` 打開它。瀏覽器沒有打開的話，自己打開這個網址。
2. 頁面會列出你的訊息、assistant 的回覆與工具輸出。工具輸出預設收合，點一下可以展開。pi 裡每完成一則訊息，就會加到頁面上；還在串流中的回覆不會顯示。如果對話以其他方式改變，例如 `/tree` 切到另一個分支，頁面會重新載入整段對話；清單裡已有的項目會保留你當時引用的文字。
3. 選取文字，選取範圍旁邊會出現筆記框，選取的文字會維持反白。輸入筆記後按 Enter，就會把引用與筆記加進右邊的清單。Shift+Enter 換行，Esc 捨棄。
4. 清單裡的項目可以編輯或刪除。
5. 按 **Send to pi editor**。pi 會依清單順序，把每一項以 `> 引用` 區塊、筆記、一行空行的格式附加到輸入框的最後面。如果輸入框原本有文字且不是以換行結尾，pi 會先補一個換行。完整的文字會留在輸入框裡，看得到也能編輯（不會收合成 `[paste #1]` 標記）。不會送給模型；文字由你編輯後自己送出。
6. 頁面會保持開啟並清空清單，你可以繼續選取、想送幾次就送幾次。

`/annotate` 是開關。這個 session 沒有伺服器在執行時，它會啟動伺服器並打開網址；有伺服器在執行時，它會停止伺服器：等待中的請求立刻結束、port 釋放，pi 顯示 `annotate: closed, port <port> released`。伺服器還在啟動時再執行 `/annotate`，結果也是停止。session 結束時伺服器也會停止：`/new`、`/resume`、fork、reload 或離開 pi。沒有閒置逾時。切換 session 之後，`/annotate` 會為新的 session 啟動新的伺服器，舊分頁會顯示 session 已切換。

如果網址不見了，執行兩次 `/annotate`：第一次停止伺服器，第二次啟動新的伺服器，給你新的網址與 token。已開啟的分頁只在伺服器停止前有效；停止後會顯示 **Server closed**、停用 **Send to pi editor**，並保留還沒送出的清單，讓你複製下來，或換到新的網址再加一次。新的伺服器不接受舊的 token。

### Markdown 與圖表

你的訊息與 assistant 的回覆會以 markdown 顯示：標題、段落、粗體、斜體、刪除線、行內程式碼、清單（巢狀與編號）、引用區塊、表格、分隔線、連結與程式碼區塊。程式碼區塊會保留縮排、使用等寬字型，並在角落標出語言。工具輸出仍然是收合的純文字。

- 只有 `http`、`https` 與 `mailto` 連結會變成連結，會在新分頁開啟並帶 `rel="noopener noreferrer"`。其他連結會顯示成原本的 markdown 文字。圖片一律不載入，頁面改顯示 `image: <替代文字>`；圖片網址是安全連結時會是一個連結。
- 頁面用 DOM 節點組出 markdown，從不把訊息文字當 HTML 解析，所以訊息裡的 HTML 會照字面顯示。

` ```mermaid ` 程式碼區塊會用 [mermaid](https://mermaid.js.org/) 畫成圖表。圖表捲動到畫面裡才會畫，同時最多畫兩張。每張圖表在自己的 sandbox iframe 裡畫（`sandbox="allow-scripts"`，沒有 `allow-same-origin`），iframe 從同一個伺服器的 `/frame` 載入；頁面把圖表原始碼傳給它，iframe 只回傳尺寸。iframe 碰不到頁面、token 或網路：它的 Content Security Policy 只允許伺服器上的 script，並擋掉連線、圖片與表單，mermaid 也以 `securityLevel: "strict"` 執行。圖表 10 秒內畫不出來時，頁面會改顯示它的原始碼程式碼區塊。`/frame` 與 `/frame/mermaid.js` 不需要 token，也不含任何對話內容。

引用程式碼與圖表：

- 起點和終點都在同一個程式碼區塊裡的選取，會引用成帶該區塊語言的程式碼區塊，例如 ` ```ts `。其他地方的選取則引用畫面上看得到的文字，不含 markdown 語法。
- 每張圖表下面的 **Show source** 可以在圖表與原始碼之間切換。在原始碼裡的選取會包在 ` ```mermaid ` 裡引用。
- **Quote whole diagram** 會打開筆記框，把整張圖表的原始碼包在 ` ```mermaid ` 裡當成一則引用。

`mermaid` 這個 dependency 會讓安裝變大。頁面只用到它 5.5 MB 的瀏覽器版本（`mermaid/dist/mermaid.min.js`），而且只在圖表 iframe 裡載入，但安裝這個套件會帶進約 117 個套件，`node_modules` 約 200 MB。

### Port 與網址

每個 pi 程序有自己的伺服器，只聽 `127.0.0.1`。預設 port 是 4747，有設定 `PI_ANNOTATE_PORT` 時用它。如果那個 port 被占用，會依序嘗試接下來九個 port（預設是 4748 到 4756），再不行就用隨機的空閒 port。所以同時開好幾個 pi，會分別拿到 4747、4748，依此類推。

網址格式是 `http://127.0.0.1:<port>/<session id>#t=<token>`。token 放在 fragment（`#` 之後），瀏覽器不會把它放進網址送給伺服器；頁面會讀取它、把它從網址列移除，之後每個請求都用 `X-Annotate-Token` header 帶上它。頁面也會把 token 存在這個分頁的 `sessionStorage`（以 session id 為鍵），所以重新整理分頁仍然可以用；token 不會放進 `localStorage`、cookie、網址或瀏覽紀錄，沙箱化的圖表 iframe 也讀不到它。不帶 `#t=` 在新分頁打開網址時，頁面會顯示未授權。伺服器不再接受這個 token 時（例如 `/annotate` 停止又重新啟動，或 pi 重新啟動），頁面會把它從 `sessionStorage` 移除、停止，並提示改開 `/annotate` 印出的新網址。請把網址當成密碼：任何拿到 token 又連得到這個 port 的人，都能把文字放進你的編輯器（但無法送給模型）。

### 透過 SSH

pi 在 SSH 裡執行時（有設定 `SSH_CONNECTION`），不會嘗試打開瀏覽器，而是印出網址與一行 `ssh -L` 指令。在你自己的電腦上轉發同一個 port，再在那邊打開網址：

```sh
ssh -L 4747:127.0.0.1:4747 <host>
```

本機 port 必須和遠端 port 相同，因為伺服器只接受 `Host` 為 `127.0.0.1:<port>` 的請求。如果 pi 用的是別的 port（例如 4748），就改轉發那個 port。你可以在第二個終端機執行 `ssh -L`，第一個終端機的 pi 繼續跑。

## 安裝

要在所有專案安裝 pi-extras，執行：

```sh
pi install git:github.com/tp6gw94/pi-extras
```

只想裝在目前的專案，加上 `--local`。pi 會把套件寫進 `.pi/settings.json`：

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

pi 啟動時，會在 `[Extensions]` 底下列出八個 extension：

```text
[Extensions]
  tp6gw94/pi-extras:annotation, tp6gw94/pi-extras:hooks, tp6gw94/pi-extras:inline-skills, tp6gw94/pi-extras:ralph, tp6gw94/pi-extras:resume-handoff,
tp6gw94/pi-extras:rpc-subagents, tp6gw94/pi-extras:skill-name-normalizer, tp6gw94/pi-extras:ux
```

## 關掉某個 extension

pi 可以略過已安裝套件裡的個別 extension。你可以在 `pi config` 畫面操作，也可以直接編輯設定檔。不論哪種方式，都要重新啟動 pi 或執行 `/reload` 才會生效。extension 附帶的 skill 會跟著它一起消失，例如 `ralph` 的 `ralph-completion`。

### 用 pi config

1. 執行 `pi config`。它會開啟個人設定。要改目前專案的設定，執行 `pi config --local`，或按 Tab。在專案範圍裡，Space 會在 inherit、`+`、`-` 之間切換。
2. 在 `git:github.com/tp6gw94/pi-extras` 底下移到要關的 extension，例如 `ralph/index.ts`，按 Space。方框會從 `[x]` 變成 `[ ]`。
3. 按 Esc 關閉。pi config 每次變更都會立刻存檔。

pi config 會在設定檔寫入一筆精確路徑的排除：

```json
{
	"packages": [
		{
			"source": "git:github.com/tp6gw94/pi-extras",
			"extensions": ["-extensions/ralph/index.ts"]
		}
	]
}
```

### 在 settings.json 裡設定

個人設定在 `~/.pi/agent/settings.json`，專案設定在 `.pi/settings.json`。把套件的 source 字串換成一個物件，`source` 不變，再加上 `extensions` 篩選。篩選裡的路徑相對於套件根目錄：

<!-- example-filter -->
```json
{
	"packages": [
		{
			"source": "git:github.com/tp6gw94/pi-extras",
			"extensions": ["!extensions/ralph/index.ts", "!extensions/resume-handoff/index.ts"]
		}
	]
}
```

篩選接受這些寫法：

| 寫法 | 效果 |
| --- | --- |
| `!pattern` | 略過所有符合 glob 的 extension，例如 `!extensions/ralph/index.ts`。 |
| `-path` | 略過這個精確路徑的 extension。pi config 寫的就是這種。 |
| `pattern` | 只載入符合的 extension。`["extensions/ux/index.ts", "extensions/hooks/index.ts"]` 只載入 ux 與 hooks。 |
| `+path` | 即使被 `!pattern` 略過，仍載入這個精確路徑的 extension。 |

空清單 `"extensions": []` 一個 extension 都不載入。不寫 `extensions` 就全部載入。`source` 要和 `pi install` 寫入的字串相同，包括 `@ref`，pi 才會把它當成同一個套件。

## 開發

開發需要 Node 22 以上（`.nvmrc` 指定 22，`nvm use` 會選用它）。

```sh
npm install
npm test
npm run typecheck
```

- `npm test` 會跑每個 extension 的測試，包括 `.ts` 與 `.mjs`。`rpc-subagents` 裡需要已安裝 pi 的測試會略過，除非你把 `RPC_SUBAGENTS_PI_PACKAGE` 設成全域安裝的 pi，例如 `~/.local/pi-1.1.0/lib/node_modules/@earendil-works/pi-coding-agent`。
- `npm run typecheck` 用 `tsconfig.json` 檢查 `ux` 與 `hooks`，用 `tsconfig.extensions.json` 檢查其他 extension。
- `annotation` 的測試涵蓋引用格式、對話快照、頁面腳本（內容一律當成文字顯示，不當 HTML），以及對真的本機伺服器做的 HTTP 測試（token、Host 與 session 檢查、送出序號、long-poll 即時更新、port 遞補）。`extensions/annotation/test/e2e/tmux-annotate.sh` 會在 tmux 裡用假的模型跑真的 pi，執行 `/annotate` 並檢查編輯器、即時更新、`/tree`、用 `/annotate` 停止與重新啟動、伺服器關閉後的頁面，以及切換 session；請把 `PI_BIN` 設成 pi 執行檔。markdown 測試涵蓋每種語法、無害化的 XSS 內容與程式碼區塊引用，伺服器測試涵蓋 `/frame` 路由、它們的 CSP 與路徑穿越。`extensions/annotation/test/e2e/browser.mjs` 用 headless Chromium 操作頁面；它需要 `playwright-core`，這不是本套件的 dependency。`extensions/annotation/test/e2e/tmux-markdown.sh` 讓 pi 回覆一段 markdown，並執行 `extensions/annotation/test/e2e/markdown.mjs` 檢查顯示結果、圖表 iframe、引用、即時更新、逾時退回、CSP 違規與網路請求；需要設定 `PI_BIN`、`PLAYWRIGHT_CORE` 與 `CHROME_BIN`。
- `scripts/acceptance.sh` 會從 git 把 pi-extras 安裝到一個暫時的 home 目錄，檢查 pi 在三種情況下載入了什麼：全部載入、用設定檔篩選，以及用 `pi config` 關掉之後。

pi 會提供 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 與 `typebox` 給 extension，所以 `package.json` 把它們列為 `"*"` 的 peer dependency。執行期 dependency 是 `croner`（給 `rpc-subagents` 的 cron 用）與 `mermaid`（給 `annotation` 的圖表用），兩者都鎖定確切版本。
