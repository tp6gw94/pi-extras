# pi-ux

[English](README.md)

pi-ux 是 [pi](https://github.com/earendil-works/pi) 的 extension，用來釘選上一則 prompt。它把你最後送出的 prompt 濃縮成一行，顯示在編輯器上方，長篇回覆捲過去時也看得到。按快捷鍵可以展開成完整內容，再按一次收合。

pi-ux 以前可以把剪貼簿引用進編輯器。引用功能已移到 [annotation](../../README.zh-TW.md#annotation) extension：執行 `/annotate`，在瀏覽器裡選取對話內容、加上留言，再以引用的形式送進編輯器。

pi-ux 在 `@earendil-works/pi-coding-agent` 1.0.4 與 Node.js 22 上測試過，fullscreen 與 regular 兩種終端機模式都有測。不需要設定檔就能用。

## 以 pi package 安裝

pi-ux 是 [pi-extras](../../README.zh-TW.md) 裡的一個 extension。要在所有專案安裝 pi-extras，執行：

```sh
pi install git:github.com/tp6gw94/pi-extras
```

只想裝在目前的專案，加上 `--local`。pi 會把套件寫進 `.pi/settings.json`：

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

pi-extras 預設載入所有 extension。要關掉其中幾個，請看[關掉某個 extension](../../README.zh-TW.md#關掉某個-extension)。

不安裝、只在一個 session 試用 pi-ux，就從 clone 下來的 pi-extras 載入 extension 檔案：

```sh
pi --extension ./extensions/ux/index.ts
```

## 2 分鐘上手

以下輸出來自 pi 1.0.4 在 110 欄寬 tmux pane 中的實際執行。`extensions/ux/test/e2e/tmux-verify.sh` 會重跑同樣的流程。

### 送出 prompt

輸入 prompt 並按 Enter。回覆結束後，prompt 會停在編輯器上方。比終端機還寬的 prompt 會以 `…` 結尾：

```text
 60 water

❯ Write the numbers 1 to 60, one per line, each followed by a short English word. This prompt is deliberately…
──────────────────────────────────────────────────────────────────────────────────────────────────────────────

──────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

agent 工作時與回答後，釘選都留在原位。其他 extension 用 `pi.sendUserMessage` 送出的訊息不會取代它。

### 展開釘選的 prompt

按 `alt+p`。釘選會顯示完整 prompt，你輸入的每一行各佔一行，並依終端機寬度換行：

```text
▾ Last prompt (alt+p to collapse)
│ Write the numbers 1 to 60, one per line, each followed by a short English word. This prompt is deliberately
│ long so that the pinned summary has to be truncated at the terminal width with an ellipsis.
│ 第二行：請用英文回答，不要加任何解釋。
│ Third line: no code blocks.
```

再按一次 `alt+p` 回到單行。

## 更改快捷鍵

預設快捷鍵如下：

| 動作 | 預設按鍵 | 設定鍵 |
| --- | --- | --- |
| 展開或收合釘選的 prompt | `alt+p` | `togglePrompt` |

pi 自己的 `keybindings.json` 只對應 pi 內建的動作，所以 pi-ux 從 `~/.pi/agent/pi-ux.json` 讀取快捷鍵。如果你設定了 `PI_CODING_AGENT_DIR`，pi-ux 會改從那個目錄讀 `pi-ux.json`。

要把展開鍵改成 `alt+o`，寫入：

<!-- example-config -->
```json
{
	"keys": {
		"togglePrompt": "alt+o"
	}
}
```

接著在 pi 裡執行 `/reload`，或重新啟動 pi。pi-ux 只在載入時讀一次這個檔案。

按鍵採用 pi 的按鍵語法：零個或多個 `ctrl`、`shift`、`alt`、`super`，以 `+` 串接，最後接一個按鍵，例如 `ctrl+alt+p` 或 `f6`。pi 載入 extension 時，會拿每個快捷鍵比對自己的按鍵：

- pi 核心動作用到的按鍵，例如 `ctrl+c` 或 `ctrl+p`，保留給 pi。pi 會略過 pi-ux 的快捷鍵，並在啟動時顯示警告。
- pi 用到的其他按鍵交給 pi-ux，pi 會在啟動時顯示警告。

pi 比對的是目前生效的按鍵，包括你自己的 `keybindings.json`。

在 macOS 與 Linux 上，pi 的預設按鍵不會用到 `alt+p`。pi 用 `shift+ctrl+p` 切換到上一個模型。在原生 Windows，以及設定了 `WSL_DISTRO_NAME` 或 `WSL_INTEROP` 的 WSL Linux 上，pi 會改用 Windows 按鍵模式。在這個模式下，pi 把 `alt+p` 綁在上一個模型。`alt+p` 在那裡是 pi 的核心按鍵，pi 會略過 pi-ux 的展開快捷鍵。在 Windows 按鍵模式下，請在 `~/.pi/agent/pi-ux.json` 設定其他按鍵。

預設用 `alt` 組合鍵，是因為 tmux、herdr 等終端機多工器使用 `ctrl+b` 前綴，而且舊式終端機會把 `alt+字母` 送成 Escape 加上該字母，pi 看得懂。`ctrl+shift+p` 這類組合鍵，只有在支援 kitty keyboard protocol 或類似延伸按鍵模式的終端機才傳得到 pi。

## 設定參考

`pi-ux.json` 是一個 JSON 物件，每個鍵都可省略。

| 鍵 | 型別 | 說明 |
| --- | --- | --- |
| `keys` | object | 依動作設定的快捷鍵。沒寫的動作沿用預設按鍵。 |

### `keys`

| 鍵 | 預設值 | 說明 |
| --- | --- | --- |
| `togglePrompt` | `alt+p` | 展開或收合釘選的 prompt。 |

把動作設成 `null` 或 `""` 就會關掉它的快捷鍵。

設定檔有問題時，pi-ux 會在 session 開始時顯示警告，並照常運作：

- 無效的按鍵改用預設按鍵。
- 不認得的設定會被忽略。
- `quoteClipboard` 是已移除的引用快捷鍵的設定鍵，會被忽略。pi-ux 會提示一次它已過時，檔案裡的其他設定照樣生效。

## 釘選 prompt 的運作方式

你從編輯器送給 agent 的每一則 prompt，pi-ux 都會釘選。由 pi 或 extension 自行處理的指令，例如 `/reload`，不會改變釘選。skill 與 prompt template 指令會送給 agent，所以 pi-ux 會照你輸入的樣子釘選。RPC client 或其他 extension 送出的文字不會取代釘選。

恢復或繼續 session 時，pi-ux 會讀取目前分支上最後一則使用者訊息並釘選。pi-ux 不另外儲存任何資料，session 檔是唯一來源。新的 session 一開始沒有釘選。

## 用 pi 跳回先前的 prompt

pi-ux 不處理對話紀錄的導覽，因為 pi 本身就有。在預設的 fullscreen 模式，`ctrl+shift+up` 與 `ctrl+shift+down` 會跳到上一則與下一則 prompt。在 regular 模式（`--tui-mode regular`），pi 會用 OSC 133 跳脫碼標記每則訊息，支援的終端機可以用它自己的按鍵在 prompt 之間跳轉。

## 限制

- 在 macOS 上，`alt` 快捷鍵需要終端機把 Option 當成 Meta 送出。Terminal.app 請開啟「Use Option as Meta key」。iTerm2 請把 Option 鍵設成「Esc+」。否則 Option 會打出特殊字元，例如 `π`。
- 在 pi 的 Windows 按鍵模式，也就是原生 Windows 與 WSL 上，預設鍵和 pi 衝突。請參考[更改快捷鍵](#更改快捷鍵)，並在 `~/.pi/agent/pi-ux.json` 設定其他按鍵。
- 恢復 session 後，pi-ux 釘選的是 session 裡最後一則使用者訊息。pi 不會記錄訊息來源，所以其他 extension 送出的使用者訊息可能會出現在那裡。
- 恢復 session 後，skill 或 prompt template 顯示的是展開後的文字，而不是你輸入的指令。

## 開發

在 pi-extras 根目錄執行：

```sh
npm install
npm test
npm run typecheck
```

`npm test` 會跑所有 pi-extras extension 的測試，包括 pi-ux 的單元測試與 README 檢查。`extensions/ux/test/e2e/tmux-verify.sh` 會在 tmux 裡操作真實的 pi session，需要已登入的模型與 `tmux`。擷取的畫面存在 `/tmp/pi-ux-ev`。
