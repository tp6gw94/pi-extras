# pi-extras

[English](README.md)

pi-extras 是一個 [pi](https://github.com/earendil-works/pi) 套件，裡面有八個 extension。安裝一次，pi 就會載入其中每個 extension。你可以在 pi 的設定裡關掉個別的 extension。

pi-extras 在 `@earendil-works/pi-coding-agent` 1.0.4 與 1.1.0、Node.js 22 上測試過。

## Extension 列表

| Extension | 用途 | 文件 |
| --- | --- | --- |
| `annotation` | 在 fullscreen 模式選取文字時，旁邊跳出一個框，把選取的內容以 `> ` 引用加上你的留言插入編輯器。 | [Annotation](#annotation) |
| `hooks` | 依 `.pi/hooks.json`，在 agent 寫入檔案後格式化，並在回合結束前 lint 改過的檔案。 | [README](extensions/hooks/README.zh-TW.md) |
| `inline-skills` | 在 prompt 中間用 `/` 選 skill，送出時附上 skill 的路徑。 | [README](extensions/inline-skills/README.md) |
| `ralph` | 用 `/ralph` 對同一個任務跑有上限的多輪全新 pi session，用 `/ralph-stop` 停止。 | |
| `resume-handoff` | 用 `/resume-handoff` 從檢查過的交接檔案開新 session。 | |
| `rpc-subagents` | 以 `pi --mode rpc` 子程序執行子代理任務與排程，用 `/rpc-subagents` 列出它們。資料與 `config.json` 放在 `~/.pi/agent/rpc-subagents/`。 | [README](extensions/rpc-subagents/README.md) |
| `skill-name-normalizer` | `~/.pi/agent/skills` 與 `~/.agents/skills` 裡的 skill 名稱不合規時，給它一個合規的名稱。 | |
| `ux` | 把上一則 prompt 釘選在編輯器上方。 | [README](extensions/ux/README.zh-TW.md) |

每個 extension 放在 `extensions/<名稱>/`，測試與它附帶的 skill 也在同一個目錄。

## Annotation

annotation 讓你在下一則 prompt 裡引用對話紀錄的一部分。在 pi 的 fullscreen 模式（預設模式）用滑鼠選取文字，放開按鍵時，選取範圍下方的那一行會跳出一個框，從放開滑鼠的那一欄開始。靠近畫面底部時，框會改跳到選取範圍上方。

- 輸入留言後按 Enter。annotation 會把選取的內容以引用插入編輯器，每一行前面加上 `> `，接著是你的留言，最後是一行空白行。它不會送出 prompt，你可以繼續編輯。不輸入留言直接按 Enter，就只插入引用。
- 按 Esc 關閉框，捨棄留言。

不論哪種方式，選取都會被清除。引用的是 pi 畫在畫面上的文字，包括程式碼區塊的縮排。從 `function` 選到下一行結尾、並留言 `What does add return?` 時，編輯器會得到：

```text
> function add(a, b) {
>      return a + b;

What does add return?
```

選取即複製照常運作。pi 的 `fullscreenCopyOnSelect` 設定開著時（預設），選取的內容也會進剪貼簿。關掉時，框照樣跳出，但不會複製任何東西。

annotation 有這些限制：

- 只在 fullscreen 模式有作用。在 regular 模式（`--tui-mode regular`），選取由終端機負責，annotation 什麼都不做。
- 在 `/settings` 切換畫面模式後，annotation 會在下一次按鍵時接上新的畫面。切換後的第一次滑鼠選取不會跳出框。
- 它用到 pi-tui `TuiAltScreen` 的私有成員：`copySelectionToClipboard`、`getActiveSelectionText`、`clearTextSelection` 與 `handleSelectionMouseEvent`。pi 更新若改了其中任何一個名字，測試會失敗。執行時如果缺少前三個之一，annotation 會自行關閉並顯示一次警告，pi 照常運作。如果只缺 `handleSelectionMouseEvent`，框會出現在畫面底部正中央。
- 和一般貼上一樣，超過 10 行或 1000 個字元的引用會收合成 pi 的貼上標記，例如 `[paste #1 +24 lines]`。送出 prompt 時，pi 會把標記展開。
- annotation 看不到編輯器的游標。如果編輯器文字不是以換行結尾，引用會從新的一行開始。

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
- `scripts/acceptance.sh` 會從 git 把 pi-extras 安裝到一個暫時的 home 目錄，檢查 pi 在三種情況下載入了什麼：全部載入、用設定檔篩選，以及用 `pi config` 關掉之後。
- `extensions/annotation/test/e2e/tmux-annotation.sh` 會在 tmux 裡用滑鼠輸入與假的本機模型，操作真實 pi 裡的 annotation。把 `PI_BIN` 設成放 pi 的目錄，例如 `PI_BIN=~/.local/pi-1.1.0/bin extensions/annotation/test/e2e/tmux-annotation.sh`。它需要 `tmux`、`python3` 與 `node`，設定了 `DISPLAY` 時會用 `xclip` 檢查剪貼簿。其他設定列在腳本開頭。

pi 會提供 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 與 `typebox` 給 extension，所以 `package.json` 把它們列為 `"*"` 的 peer dependency。`croner` 是唯一的執行期 dependency。
