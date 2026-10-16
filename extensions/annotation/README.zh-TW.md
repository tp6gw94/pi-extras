# pi-annotation

[English](README.md)

pi-annotation 是 [pi](https://github.com/earendil-works/pi) 的 extension，讓你引用目前對話的段落、加上筆記，再附加到 pi 編輯器。你可以用 `/annotate` 在瀏覽器的即時頁面上引用，或用 `/annotate tui` 在另一個 pane 的終端機檢視裡引用。pi-annotation 不會把任何東西送給模型。文字由你在編輯器裡修改後自己送出。

pi-annotation 不會卡住 pi。頁面或終端機檢視開著的時候，你可以繼續工作。pi 每完成一則訊息，訊息就會出現在上面。

## 以 pi package 安裝

pi-annotation 是 [pi-extras](../../README.zh-TW.md) 裡的一個 extension。要在所有專案安裝 pi-extras，執行：

```sh
pi install git:github.com/tp6gw94/pi-extras
```

只想裝在目前的專案，加上 `--local`。pi 會把套件寫進 `.pi/settings.json`：

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

pi-extras 預設載入所有 extension。要關掉其中幾個，請看[關掉某個 extension](../../README.zh-TW.md#關掉某個-extension)。

不安裝、只在一個 session 試用 pi-annotation，先在 clone 下來的 pi-extras 裡執行 `npm install`，再從 clone 載入 extension 檔案：

```sh
pi --extension ./extensions/annotation/index.ts
```

## 在瀏覽器裡引用對話

1. 執行 `/annotate`。pi 會為這個 session 啟動一個小伺服器，印出像 `http://127.0.0.1:4747/<session id>#t=<token>` 的網址。pi 會在 macOS 用 `open`、在 Linux 用 `xdg-open` 打開這個網址。瀏覽器沒有打開的話，自己打開這個網址。
2. 在頁面上閱讀對話。頁面會列出你的訊息、assistant 的回覆與工具輸出。工具輸出預設收合，點一下可以展開。pi 在每則訊息完成時才把它加到頁面上，所以還在串流中的回覆不會顯示。如果對話以其他方式改變，例如 `/tree` 切到另一個分支，頁面會重新載入整段對話。清單裡已有的項目會保留你當時引用的文字。
3. 選取文字。選取範圍旁邊會出現筆記框，選取的文字會維持反白。輸入筆記後按 Enter，就會把引用與筆記加進右邊的清單。Shift+Enter 換行。Esc 捨棄這則筆記。
4. 編輯或刪除清單裡的項目。
5. 按 **Send to pi editor**。pi 會依清單順序，把每一項附加到輸入框的最後面。每一項的格式是 `> 引用` 區塊、筆記、一行空行。如果輸入框裡原本的文字不是以換行結尾，pi 會先補一個換行。完整的文字會留在輸入框裡，看得到也能編輯。pi 不會把它收合成 `[paste #1]` 標記。
6. 繼續引用。頁面會保持開啟並清空清單，你可以繼續選取、想送幾次就送幾次。

### 用 `/annotate` 停止伺服器

`/annotate` 是開關。這個 session 沒有伺服器在執行時，`/annotate` 會啟動伺服器並打開網址。有伺服器在執行時，`/annotate` 會停止它。等待中的請求立刻結束，pi 釋放 port，並顯示 `annotate: closed, port <port> released`。伺服器還在啟動時執行 `/annotate`，伺服器最後也會停止。

session 結束時伺服器也會停止：`/new`、`/resume`、fork、reload 或離開 pi。伺服器沒有閒置逾時。切換 session 之後，`/annotate` 會為新的 session 啟動新的伺服器，舊分頁會顯示 session 已切換。

### 取得新的網址

如果網址不見了，執行兩次 `/annotate`。第一次停止伺服器，第二次啟動新的伺服器，給你新的網址與 token。新的伺服器不接受舊的 token。

已開啟的分頁只在它的伺服器停止前有效。停止後，分頁會顯示 **Server closed**、停用 **Send to pi editor**，並保留還沒送出的清單。你可以把清單複製下來，或打開新的網址再把項目加一次。

## 在終端機裡引用對話

`/annotate tui` 會啟動同一個伺服器，但不開啟瀏覽器。這樣你就能從另一個終端機或 pane 引用對話，同時繼續使用 pi。pi 會印出連接的指令：

```text
annotate: TUI session live on 127.0.0.1:4747
Attach from another terminal: '/your/pi-extras/extensions/annotation/bin/pi-annotation.ts' 019ee068-1f2c-7a3b-9c4d-6e5f...
Run /annotate again to stop it.
```

把引號裡的指令複製到另一個終端機。執行檔在 `extensions/annotation/bin/pi-annotation.ts`，pi 不會把它放進你的 `PATH`，所以請用通知裡的絕對路徑。執行檔直接執行 TypeScript，需要 Node 22.6 以上。

執行檔的參數可以是完整的 session id，或其中唯一的一段。不帶參數時，它會連上唯一活著的 session，或唯一一個工作目錄與目前目錄相同的活著的 session。`pi-annotation --list` 會列出活著的 session，`pi-annotation --help` 會顯示用法。

再執行一次 `/annotate tui` 會再印一次連接指令，不會重啟伺服器。單純的 `/annotate` 會停止伺服器，與瀏覽器頁面的情況相同。瀏覽器頁面與終端機檢視可以同時使用同一個伺服器。

### 用類似 vim 的按鍵移動與引用

終端機檢視顯示與瀏覽器頁面相同的對話。工具輸出預設收合。按鍵如下：

| 按鍵 | 動作 |
| --- | --- |
| `h` `j` `k` `l`、方向鍵 | 移動。`j` 與 `k` 以畫面列為單位。 |
| `w` `b` `e` | 以詞為單位移動 |
| `0` `^` `$`、Home、End | 行首、第一個非空白、行尾 |
| `gg` `G` | 整段對話的開頭與結尾 |
| `{` `}` | 上一則與下一則訊息 |
| Ctrl-d、Ctrl-u | 半頁 |
| Ctrl-f、Ctrl-b、PageUp、PageDown | 整頁 |
| `v`、`V` | 開始字元或整行選取。`o` 交換兩端。Esc 離開選取。 |
| `a` | 為選取範圍加筆記，沒有選取時為游標所在的那一行。在訊息標題上，筆記涵蓋整則訊息。在圖表上，筆記涵蓋整個 ` ```mermaid ` 區塊。 |
| `A` | 為整則訊息加筆記，包含收合的工具輸出 |
| Enter、`za` | 收合或展開游標所在的工具輸出，或在圖表與其原始碼之間切換 |
| `zR`、`zM` | 展開或收合所有工具輸出 |
| `zz` | 把游標置中 |
| `/` | 搜尋。`n` 與 `N` 往前、往後重複。 |
| Tab | 打開筆記清單。在清單裡，`j` 與 `k` 移動，Enter 跳到來源，`e` 編輯，`d` 刪除，Tab、Esc 或 `q` 返回。 |
| 筆記框（按 `a` 或 `A` 之後） | Enter 儲存。Ctrl-J 換行，終端機有回報 Shift+Enter 時也可以用它換行。Esc 取消。 |
| `s` | 把所有筆記送到 pi 編輯器 |
| `?` | 顯示按鍵 |
| `q` | 離開。還有沒送出的筆記時要按兩次。 |

按鍵可以加次數前綴，例如 `3j` 或 `2}`。

一則筆記就是 `> 引用` 區塊加上筆記文字，與瀏覽器頁面相同。**Send** 會把每則筆記附加到 pi 編輯器，不會送給模型。檢視開著時新的訊息會出現，你的筆記、游標與選取都會保留。對話切到其他分支、而選取所在的訊息已經改變時，檢視會丟棄這個選取並顯示簡短提示。

### 以文字閱讀圖表

終端機檢視會用 `grok-mermaid`，把你的訊息與 assistant 回覆裡的 ` ```mermaid ` 區塊畫成 Unicode 文字圖表。flowchart、state、class、ER 與 sequence diagram 都能畫。在圖表上按 Enter 或 `za` 會在圖表與原始碼之間切換。在圖表上按 `a` 會引用整個區塊，所以筆記會帶著 ` ```mermaid ` 原始碼。

以下三種情況，圖表會退回顯示原始碼：

- `grok-mermaid` 畫不出來，因為圖表不支援或格式錯誤。
- 圖表比 pane 寬。
- `grok-mermaid` 回報警告，這發生在它只支援一部分的 flowchart。檢視會在原始碼下面多加一列暗色的 `Mermaid diagram not rendered: <第一個警告>`，警告不只一個時加上 ` (+N more)`。

把 pane 縮到比圖表窄，檢視會改顯示原始碼。再放大，檢視就會重新畫成圖表。

### 保護 session 記錄

pi 會在 agent 目錄下為伺服器寫一筆記錄：`<agent dir>/annotation/sessions/<pi pid>.json`。記錄裡有 port、token 與 pi 的 process id。目錄只有擁有者可存取（`0700`），每個檔案是 `0600`。伺服器停止與 pi 離開時，pi 會刪掉記錄。執行檔連接或列出 session 時，會刪掉已經不在執行的 pi 留下的記錄。token 與瀏覽器網址帶的是同一個祕密，請把它當成密碼。

## 瀏覽器裡的 Markdown 與圖表

頁面會把你的訊息與 assistant 的回覆以 markdown 顯示：標題、段落、粗體、斜體、刪除線、行內程式碼、清單（巢狀與編號）、引用區塊、表格、分隔線、連結與程式碼區塊。程式碼區塊會保留縮排、使用等寬字型，並在角落標出語言。工具輸出仍然是收合的純文字。

- 只有 `http`、`https` 與 `mailto` 連結會變成連結，並在新分頁開啟、帶 `rel="noopener noreferrer"`。其他連結會顯示成原本的 markdown 文字。
- 頁面一律不載入圖片，改顯示 `image: <替代文字>`。圖片網址是安全連結時，這段文字會是一個連結。
- 頁面用 DOM 節點組出 markdown，從不把訊息文字當 HTML 解析，所以訊息裡的 HTML 會照字面顯示。

頁面會用 [mermaid](https://mermaid.js.org/) 把 ` ```mermaid ` 程式碼區塊畫成圖表。圖表捲動到畫面裡才會畫，同時最多畫兩張。每張圖表在自己的 sandbox iframe 裡畫（`sandbox="allow-scripts"`，沒有 `allow-same-origin`），iframe 從同一個伺服器的 `/frame` 載入。頁面把圖表原始碼傳給 iframe，iframe 只回傳尺寸。

iframe 碰不到頁面、token 或網路。它的 Content Security Policy 只允許伺服器上的 script，並擋掉連線、圖片與表單。mermaid 以 `securityLevel: "strict"` 執行。iframe 10 秒內畫不出圖表時，頁面會改用程式碼區塊顯示圖表原始碼。`/frame` 與 `/frame/mermaid.js` 不需要 token，也不含任何對話內容。

### 引用程式碼與圖表

- 起點和終點都在同一個程式碼區塊裡的選取，會引用成帶該區塊語言的程式碼區塊，例如 ` ```ts `。其他地方的選取則引用畫面上看得到的文字，不含 markdown 語法。
- 每張圖表下面的 **Show source** 可以在圖表與原始碼之間切換。在原始碼裡的選取會包在 ` ```mermaid ` 裡引用。
- **Quote whole diagram** 會打開筆記框，把整張圖表的原始碼包在 ` ```mermaid ` 裡當成一則引用。

### mermaid 的安裝大小

`mermaid` 這個 dependency 會讓安裝變大。頁面只用到它 5.5 MB 的瀏覽器版本（`mermaid/dist/mermaid.min.js`），而且只在圖表 iframe 裡載入。但安裝這個套件仍會帶進約 117 個套件，`node_modules` 約 200 MB。

## Port 與網址

每個 pi 程序有自己的伺服器，只聽 `127.0.0.1`。伺服器預設用 port 4747，有設定 `PI_ANNOTATE_PORT` 時用它。如果那個 port 被占用，伺服器會依序嘗試接下來九個 port（預設是 4748 到 4756），再不行就用隨機的空閒 port。所以同時開好幾個 pi，會分別拿到 4747、4748，依此類推。

網址格式是 `http://127.0.0.1:<port>/<session id>#t=<token>`。token 放在 fragment（`#` 之後），所以瀏覽器不會把它放進網址送給伺服器。頁面會讀取 token、把它從網址列移除，之後每個請求都用 `X-Annotate-Token` header 帶上它。

頁面也會把 token 存在這個分頁的 `sessionStorage`，以 session id 為鍵，所以重新整理分頁仍然可以用。頁面不會把 token 放進 `localStorage`、cookie、網址或瀏覽紀錄，沙箱化的圖表 iframe 也讀不到它。不帶 `#t=` 在新分頁打開網址時，頁面會顯示未授權。

`/annotate` 停止又重新啟動伺服器，或 pi 重新啟動之後，伺服器就不再接受這個 token。這時頁面會把 token 從 `sessionStorage` 移除、停止，並提示你打開 `/annotate` 印出的新網址。

請把網址當成密碼。任何拿到 token 又連得到這個 port 的人，都能把文字放進你的編輯器，但無法送給模型。

## 透過 SSH 使用

pi 在 SSH 裡執行時（有設定 `SSH_CONNECTION`），不會嘗試打開瀏覽器，而是印出網址與一行 `ssh -L` 指令。在你自己的電腦上轉發同一個 port，再在那邊打開網址：

```sh
ssh -L 4747:127.0.0.1:4747 <host>
```

本機 port 必須和遠端 port 相同，因為伺服器只接受 `Host` 為 `127.0.0.1:<port>` 的請求。如果 pi 用的是別的 port，例如 4748，就改轉發那個 port。你可以在第二個終端機執行 `ssh -L`，第一個終端機的 pi 繼續跑。

## 開發

在 pi-extras 的根目錄執行：

```sh
npm install
npm run typecheck
npm test
```

`npm test` 會跑 pi-extras 每個 extension 的測試。pi-annotation 的測試涵蓋這些部分：

- 引用格式、對話快照與頁面腳本。頁面腳本的測試會檢查內容一律當成文字顯示，不當 HTML。
- 對真的本機伺服器做的 HTTP 測試：token、Host 與 session 檢查、送出序號、long-poll 即時更新與 port 遞補。伺服器測試也涵蓋 `/frame` 路由、它們的 CSP 與路徑穿越。
- markdown：每種語法、無害化的 XSS 內容與程式碼區塊引用。
- 終端機檢視：document 模型與 reducer、用真的 pi-tui 程式庫加假終端機的 app 測試、session registry 與 `/annotate tui`。

end-to-end 腳本會用假的模型跑真的 pi。每個腳本都需要把 `PI_BIN` 設成 pi 執行檔。

- `extensions/annotation/test/e2e/tmux-annotate.sh` 在 tmux 裡執行 `/annotate`。它檢查編輯器、即時更新、`/tree`、用 `/annotate` 停止與重新啟動、伺服器關閉後的頁面，以及切換 session。
- `extensions/annotation/test/e2e/herdr-tui.sh` 在 herdr 的兩個 pane 裡跑 pi 與執行檔。它檢查筆記流程、即時回覆、離開與停止。它還需要 `HERDR_ENV=1`，所以請在 herdr 裡執行。
- `extensions/annotation/test/e2e/tmux-markdown.sh` 讓 pi 回覆一段 markdown，並執行 `extensions/annotation/test/e2e/markdown.mjs`。這個腳本檢查顯示結果、圖表 iframe、引用、即時更新、逾時退回、CSP 違規與網路請求。它還需要 `PLAYWRIGHT_CORE` 與 `CHROME_BIN`。

`extensions/annotation/test/e2e/browser.mjs` 用 headless Chromium 操作頁面。它需要 `playwright-core`，這不是 pi-extras 的 dependency。
