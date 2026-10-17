# RPC subagents 交付狀態

已完成本次核准範圍。所有子代理由真正的 `pi --mode rpc` 執行，沒有 SDK fallback。使用指南見 [README](README.md)。

## 實作

- 同步與背景任務，可指定 model、thinking、prompt 及 fresh 或 fork。
- Codemode 可依序 chain 或以 Promise.allSettled 平行呼叫。
- 主 Pi 提供即時 widget 與 `/rpc-subagents` 互動清單。
- Herdr 可按需開啟同一任務的 replay/live viewer，重用 pane，不搶焦點。
- 主 Pi 在線時執行持久排程，支援 at、interval、時區 cron、pause、resume 與取消。取消可選擇中止該排程的 active tasks。
- 關閉主程序清理 owned children、timers 與 owner lock，不接管其他 Pi 的工作。

## Session replacement 存活

同一 Node 程序內的 `new`、`resume`、`fork` 現在保留背景與排程任務的原有 fleet、leases 與 owners，跨 cwd 的 resume 也使用同一份 process host。新 adapter 重綁通知與 widget；切換空窗的完成通知及仍待回答的 asks 補到新 session，但不自行啟動 turn。舊 session 已收到或由工具觀察到的 terminal 結果不重播。`/resume-handoff auto` 提示會要求記錄任務 ID、用途及結果／問題的讀取和回覆方式，不等待或取消這些任務。

同 VM 重複呼叫 factory 的 adapter 測試涵蓋三種保留原因、quit／reload 清理、空窗完成、pending ask 重送與回覆、十次替換的 listener／widget 數量、初始化中的替換、TUI 接續通知、preparer 通知重綁及舊 adapter 拒絕工具。另測初始化失敗不重試、失敗綁定只警告並保持未綁定。這些是 stub 測試，尚未以真實 Pi TUI、跨 cwd loader 重載或真實 child 程序驗證此次 session replacement。

已知限制：

- `/reload` 與退出仍中止任務。
- 同步 `rpc_subagents_run` 在 shutdown handler 前就會被 `session.abort()` 取消，僅背景與排程任務存活。
- 新 runtime 若不載入擴充功能，host 保持未綁定，children 繼續但不喚醒 session；退出沒有 handler 能正常清理，程序結束才關閉管線。
- 保留原物件圖依賴現行 loader 的同 cwd factory 快取及同 Node 程序，不是公開生命週期保證；Pi 文件仍建議只跨 replacement 保存 plain data。

## 原始交付驗證

89 項測試通過，0 fail、0 skip。語法與嚴格型別檢查通過。獨立 source review 沒有剩餘問題。核心 RPC、codemode、同行程 TUI、排程中止與 Herdr 開啟及重用均有實際證據。

含真實 compaction/context_edit 的 fork、cron/DST 活體、跨程序 owner 競態、啟動後對話，以及有執行中任務的 reload 尚未活體驗證。Provider 啟動期等待對話目前明確不支援。

## 交付邊界

依賴已安裝並固定為 croner@9.1.0。沒有修改使用者既有設定、auth 或 pi-subagents，沒有 stage、commit 或 publication。執行紀錄存於私有 data，測試排程已取消，驗證建立的 panes 與程序已清理。此版本其後更名為 `rpc-subagents`；舊 `rpc-fleet` 目錄僅保留既有 `data/`，作為既有安裝的儲存根目錄。
