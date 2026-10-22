# pi-extras

[English](README.md)

pi-extras 是一個 [pi](https://github.com/earendil-works/pi) 套件，裡面有九個 extension。安裝一次，pi 就會載入其中每個 extension。你可以在 pi 的設定裡關掉個別的 extension。

pi-extras 需要 `@earendil-works/pi-coding-agent` 1.3.0 以上與 Node.js 22。

## Extension 列表

| Extension | 用途 | 文件 |
| --- | --- | --- |
| `annotation` | 引用對話段落並加上筆記，再附加到編輯器。可從瀏覽器頁面、終端機檢視，或在全螢幕 TUI 用 `/annotation-mode` 引用。`/annotate` 啟動伺服器，再執行一次就會停止。 | [README](extensions/annotation/README.zh-TW.md) |
| `hooks` | 依 `.pi/hooks.json`，在 agent 寫入檔案後格式化，並在回合結束前 lint 改過的檔案。 | [README](extensions/hooks/README.zh-TW.md) |
| `inline-skills` | 在 prompt 中間用 `/` 選 skill，送出時附上 skill 的路徑。 | [README](extensions/inline-skills/README.md) |
| `quota-resume` | 訂閱配額有明確重設時間時，在原 session 自動續跑一次；支援持久化等待與取消。 | [README](extensions/quota-resume/README.zh-TW.md) |
| `ralph` | 用 `/ralph` 對同一個任務跑有上限的多輪全新 pi session，用 `/ralph-stop` 停止。 | |
| `resume-handoff` | 從既有交接檔案開新 session，或用 `/resume-handoff auto` 請目前 agent 撰寫交接檔案。可選擇在 context 用量達到門檻時自動交接。 | [README](extensions/resume-handoff/README.zh-TW.md) |
| `rpc-subagents` | 以 `pi --mode rpc` 子程序執行子代理任務與排程，用 `/rpc-subagents` 列出它們。child 會載入你設定中的 extension（排除 `rpc-subagents`、`annotation`、`ux`、`hooks`），所以你的 provider 在 child 裡也能用。資料與 `config.json` 放在 `~/.pi/agent/rpc-subagents/`。 | [README](extensions/rpc-subagents/README.md) |
| `skill-name-normalizer` | `~/.pi/agent/skills` 與 `~/.agents/skills` 裡的 skill 名稱不合規時，給它一個合規的名稱。 | |
| `ux` | 把上一則 prompt 釘選在編輯器上方。 | [README](extensions/ux/README.zh-TW.md) |

每個 extension 放在 `extensions/<名稱>/`，測試與它附帶的 skill 也在同一個目錄。

## 安裝

要在所有專案安裝 pi-extras，執行：

```sh
pi install git:github.com/tp6gw94/pi-extras
```

只想裝在目前的專案，加上 `--local`。pi 會把套件寫進 `.pi/settings.json`：

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

pi 啟動時，會在 `[Extensions]` 底下列出九個 extension：

```text
[Extensions]
  tp6gw94/pi-extras:annotation, tp6gw94/pi-extras:hooks, tp6gw94/pi-extras:inline-skills, tp6gw94/pi-extras:quota-resume, tp6gw94/pi-extras:ralph, tp6gw94/pi-extras:resume-handoff,
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

pi 會提供 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 與 `typebox` 給 extension，因此它們列為 peer dependency。coding-agent 的最低版本為 1.3.0，因為自動交接依賴該版本的 custom message 啟動生命週期。執行期 dependency 是 `croner`（給 `rpc-subagents` 的 cron 用）、`mermaid`（給 `annotation` 瀏覽器頁面的圖表用）與 `grok-mermaid`（給 `annotation` 終端機檢視的文字圖表用），三者都鎖定確切版本。
