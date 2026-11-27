# Herdr 對話標註

在 Herdr 桌面版的原生分頁閱讀並標註目前的 Pi 對話。Herdr mod 隨 `pi-extras` 發布。安裝 Pi extension 不會順帶安裝 mod，也不會修改 Herdr 設定。

## 安裝

需要 Herdr 桌面版（`PATH` 裡能找到 `herdr-app`），以及支援 `node:sqlite` 的 Node.js（22.13 或更新版本）。

如果 Pi 還沒安裝 `pi-extras`，請執行 `pi install git:github.com/tp6gw94/pi-extras`。接著到 `pi-extras` 的檔案目錄執行：

```sh
node extensions/annotation/bin/install-herdr-annotation.mjs
```

如果是以 npm 套件安裝，也可直接執行 `pi-extras-install-herdr-annotation`。

安裝程式會將 mod 複製到 `$HERDR_APP_HOME/mods/pi-annotate/`。未設定 `HERDR_APP_HOME` 時，會用 `~/.config/herdr-app/mods/pi-annotate/`。同名項目已存在時，安裝程式會停止。若要更新手動安裝的版本，先將舊副本備份到 Herdr 的 `mods/` 目錄之外，再執行安裝。安裝程式不會修改版面設定，也不會刪除草稿或留言。

## 使用

在 Herdr 桌面版的本機 Pi session 裡執行 `/annotate-herdr`。再次執行會回到既有的標註分頁。標註分頁一直對應到來源 session，不會隨目前焦點切換到別的 Pi。重啟 Pi 後如果分頁仍斷線，請在來源 session 執行 `/annotate-herdr`，再到 Herdr 點 **Reconnect**。

點一下逐字稿就能用 `hjkl` 移動、`Ctrl+D`／`Ctrl+U` 翻半頁、`gg`／`G` 跳到首尾。按 `v` 在單則訊息內選取，`c` 開留言，`Esc` 取消選取。也可以用滑鼠拖選後按 **Add comment**。

右欄依送出目的地分成兩區：

- **Main Pi** 把自由文字和這個分支的待送留言合成一則，直接送到原本的 session，不動 Pi 的輸入框。如果 Pi 忙碌或無法確認送出，草稿會保留。
- **Background threads** 是各自獨立、唯讀的背景對話。可以用引文留言或自由文字開新串；回覆會沿用該串的 session。按 **Add to main Pi drafts** 才會把原留言和已完成的問答複製到主 Pi 草稿，原本的背景串不變。

`Enter` 儲存但不送出，`Shift+Enter` 換行。在 macOS，`⌘ Enter` 送給主 Pi，`⌘ Shift+Enter` 開啟或回覆背景串。其他平台用 `Ctrl` 代替 `⌘`。

如果送出尚未確認，請點 **Check previous send**。只要來源 Pi 仍可能送達，就只能在看到訊息後確認已送出，不能標記為未送出。**Check pending start** 會重試原本的背景開串請求，保留後來輸入的草稿。

工具輸出預設收合，可以逐則展開。

## 從舊標註介面升級

新版不再提供瀏覽器介面、終端附掛指令或 Pi 全螢幕標註模式。請以 `/annotate-herdr` 取代 `/annotate` 與 `/annotation-mode`。新版沿用原有 Herdr 標註資料位置。
