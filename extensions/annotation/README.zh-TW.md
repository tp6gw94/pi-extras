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

- 在逐字稿選取文字後，點 **Add comment**。用滑鼠選取時，編輯框會在選取處旁開啟。按 **⌘ Enter**（其他平台用 **Ctrl+Enter**）儲存留言，不會送給 Pi。
- **Put in original Pi input** 會把引文和待處理留言附加到原本 Pi 的輸入框，不會提交。
- **Send to background Pi** 會針對已存留言開啟獨立、唯讀的背景 Pi 對話。在其中回覆不會送到原本的 session。

工具輸出預設收合，可以逐則展開。對話訊息仍會完整保留，已儲存的留言可在右欄查看。

## 從舊標註介面升級

新版不再提供瀏覽器介面、終端附掛指令或 Pi 全螢幕標註模式。請以 `/annotate-herdr` 取代 `/annotate` 與 `/annotation-mode`。新版沿用原有 Herdr 標註資料位置。
