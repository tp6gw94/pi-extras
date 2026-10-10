# pi-ux

[English](README.md)

pi-ux 是 [pi](https://github.com/earendil-works/pi) 的 extension，提供兩個編輯器小工具：

- **釘選上一則 prompt。** pi-ux 把你最後送出的 prompt 濃縮成一行，顯示在編輯器上方，長篇回覆捲過去時也看得到。按快捷鍵可以展開成完整內容，再按一次收合。
- **引用剪貼簿。** 按快捷鍵或執行 `/quote`，pi-ux 會把剪貼簿內容插入游標位置，每一行前面加上 `> `，讓你不必重打就能針對一段文字發問。

pi-ux 在 `@earendil-works/pi-coding-agent` 1.0.4 與 Node.js 22 上測試過，fullscreen 與 regular 兩種終端機模式都有測。不需要設定檔就能用。

## 以 pi package 安裝

要在所有專案安裝 pi-ux，執行：

```sh
pi install git:github.com/tp6gw94/pi-ux
```

只想裝在目前的專案，加上 `--local`。pi 會把套件寫進 `.pi/settings.json`：

```sh
pi install --local git:github.com/tp6gw94/pi-ux
```

不安裝、只在一個 session 試用，就從 clone 下來的目錄載入 extension 檔案：

```sh
pi --extension ./ux-pi/index.ts
```

## 2 分鐘上手

以下輸出來自 pi 1.0.4 在 110 欄寬 tmux pane 中的實際執行。`test/e2e/tmux-verify.sh` 會重跑同樣的流程。

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

### 引用剪貼簿

複製一段文字，打好問題的開頭，再按 `alt+q`。pi-ux 會把剪貼簿插入游標位置，你打好的字都保留：

```text
Explain this code:
> const x = 1;
> function add(a, b) {
>   return a + b;
> }

What does add return?
```

引用最後會接一行空白行，你可以直接在下面繼續打字。執行 `/quote` 效果相同。剪貼簿是空的時候，pi-ux 不插入任何東西，並顯示警告：

```text
 Warning: pi-ux: the clipboard is empty (read with xsel). Nothing inserted.
```

## 更改快捷鍵

預設快捷鍵如下：

| 動作 | 預設按鍵 | 設定鍵 |
| --- | --- | --- |
| 展開或收合釘選的 prompt | `alt+p` | `togglePrompt` |
| 把剪貼簿插入為引用 | `alt+q` | `quoteClipboard` |

pi 自己的 `keybindings.json` 只對應 pi 內建的動作，所以 pi-ux 從 `~/.pi/agent/pi-ux.json` 讀取快捷鍵。如果你設定了 `PI_CODING_AGENT_DIR`，pi-ux 會改從那個目錄讀 `pi-ux.json`。

要把展開鍵改成 `alt+o`，並關掉引用快捷鍵，寫入：

<!-- example-config -->
```json
{
	"keys": {
		"togglePrompt": "alt+o",
		"quoteClipboard": null
	}
}
```

接著在 pi 裡執行 `/reload`，或重新啟動 pi。pi-ux 只在載入時讀一次這個檔案。

按鍵採用 pi 的按鍵語法：零個或多個 `ctrl`、`shift`、`alt`、`super`，以 `+` 串接，最後接一個按鍵，例如 `ctrl+alt+p` 或 `f6`。pi 載入 extension 時，會拿每個快捷鍵比對自己的按鍵：

- pi 核心動作用到的按鍵，例如 `ctrl+c` 或 `ctrl+p`，保留給 pi。pi 會略過 pi-ux 的快捷鍵，並在啟動時顯示警告。
- pi 用到的其他按鍵交給 pi-ux，pi 會在啟動時顯示警告。

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
| `quoteClipboard` | `alt+q` | 把剪貼簿以引用形式插入游標位置。 |

把動作設成 `null` 或 `""` 就會關掉它的快捷鍵。`/quote` 指令仍然可用。

設定檔有問題時，pi-ux 會在 session 開始時顯示警告，並照常運作：

- 無效的按鍵改用預設按鍵。
- 不認得的設定會被忽略。
- 兩個動作設成同一個按鍵時，第二個動作沒有快捷鍵。

## 釘選 prompt 的運作方式

你從編輯器送給 agent 的每一則 prompt，pi-ux 都會釘選。由 pi 或 extension 自行處理的指令，例如 `/reload` 或 `/quote`，不會改變釘選。skill 與 prompt template 指令會送給 agent，所以 pi-ux 會照你輸入的樣子釘選。RPC client 或其他 extension 送出的文字不會取代釘選。

恢復或繼續 session 時，pi-ux 會讀取目前分支上最後一則使用者訊息並釘選。pi-ux 不另外儲存任何資料，session 檔是唯一來源。新的 session 一開始沒有釘選。

## 引用的運作方式

pi-ux 依序嘗試下列工具讀取剪貼簿，採用第一個成功的，每個工具最多等 1.5 秒：

1. `pbpaste`（macOS）
2. `wl-paste --no-newline`（Wayland）
3. `xclip -selection clipboard -o`（X11）
4. `xsel --clipboard --output`（X11）

工具不存在、失敗或逾時，就換下一個。全部都不行時，pi-ux 會顯示警告，列出試過的工具。

接著 pi-ux 會整理文字：

- Windows 換行轉成 `\n`，結尾的空白行會被去掉。
- 每一行前面加上 `> `。空白行變成 `> `。
- 引用後面接一行空白行。
- 如果編輯器裡已經有文字，而且不是以換行結尾，引用會從新的一行開始。

pi-ux 用 `ctx.ui.pasteToEditor` 插入結果，跟終端機貼上走同一條路。和一般貼上一樣，超過 10 行或 1000 個字元的引用會收合成 pi 的貼上標記，例如 `[paste #1 +24 lines]`。送出 prompt 時，pi 會把標記展開成完整引用。

## 用 pi 跳回先前的 prompt

pi-ux 不處理對話紀錄的導覽，因為 pi 本身就有。在預設的 fullscreen 模式，`ctrl+shift+up` 與 `ctrl+shift+down` 會跳到上一則與下一則 prompt。在 regular 模式（`--tui-mode regular`），pi 會用 OSC 133 跳脫碼標記每則訊息，支援的終端機可以用它自己的按鍵在 prompt 之間跳轉。

## 限制

- 在 macOS 上，`alt` 快捷鍵需要終端機把 Option 當成 Meta 送出。Terminal.app 請開啟「Use Option as Meta key」。iTerm2 請把 Option 鍵設成「Esc+」。否則 Option 會打出特殊字元，例如 `π`。
- 在 Windows 與 WSL 上，pi 把 `alt+p` 綁在反向切換模型，這是保留按鍵，所以 pi-ux 會略過展開快捷鍵。pi 在那裡也綁了 `alt+q`，pi-ux 會接手。在這些系統上請在 `pi-ux.json` 設定其他按鍵。
- `/quote` 是從編輯器執行的，所以執行前打的字會消失。要保留已輸入的文字，請用快捷鍵。
- pi-ux 看不到游標位置，所以只能依編輯器文字的結尾，決定引用要不要從新的一行開始。
- 恢復 session 後，pi-ux 釘選的是 session 裡最後一則使用者訊息。pi 不會記錄訊息來源，所以其他 extension 送出的使用者訊息可能會出現在那裡。
- 恢復 session 後，skill 或 prompt template 顯示的是展開後的文字，而不是你輸入的指令。

## 開發

```sh
npm install
npm test
npm run typecheck
```

`npm test` 會跑單元測試與 README 檢查。`test/e2e/tmux-verify.sh` 會在 tmux 裡操作真實的 pi session，需要已登入的模型、`tmux`、`xclip`、`xsel`，以及 Xvfb 之類的 X server。擷取的畫面存在 `/tmp/pi-ux-ev`。
