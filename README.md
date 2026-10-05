# codex-monitor

Claude Code 的 mod：在 Claude Code 裡開一個 pane，即時顯示**目前這個 Claude session** 派出去的 Codex 工作在做什麼。

> **只支援 Windows。** 讀大型 rollout 檔時會呼叫 PowerShell 7（`pwsh`），並從 `USERPROFILE`、`TEMP` 找檔案位置。

## 會追蹤哪些 Codex 工作

| 派送方式 | 怎麼判斷是這個 session 派的 |
| --- | --- |
| [codex plugin](https://github.com/openai/codex-plugin-cc)（`/codex:rescue` 等） | plugin 的 `state.json` 為每個 job 記下 Claude 的 `sessionId` 與 Codex 的 `threadId` |
| Bash / PowerShell 執行的 `codex exec` | 指令送出時登記，再用 rollout 檔裡的第一則提示詞比對指令內容；同一個指令裡有幾個 `codex exec` 就登記幾筆 |
| [claude-codex-bridge](https://github.com/ar36planet/claude-codex-bridge-public) 的 `codex_message_send` | 從工具的輸入或回傳結果取出 `threadId` |

取得 `threadId` 之後，讀 `~/.codex/sessions/` 底下對應的 rollout 檔（`rollout-*-<threadId>.jsonl`）來顯示內容。

## 畫面

```
● [exec] exec Read src/mcp/outputBudget.mjs… · ✓ Get-Content …
● [exec] exec Read src/mcp/selection.mjs…    · codex: I'll read …
── ● exec Read src/mcp/outputBudget.mjs… ──
10:56:55 tool  ✓  Get-Content -LiteralPath 'src/mcp/outputBudget.mjs'
10:57:12 codex - Measures text size in UTF-8 bytes. …
── ● exec Read src/mcp/selection.mjs… ──
10:56:56 tool  ✓  Get-Content -LiteralPath 'src/mcp/selection.mjs'
10:57:09 codex - `selectThread` returns an explicit thread ID …
```

- **上半部**：每一筆工作一行，顯示來源、執行中（●）或結束（○），以及最新的一行動態。
- **下半部**：自動決定顯示什麼，平常不用按鍵。
  - 同時有 2 個以上在跑：分格顯示，最多 4 格，每格是該工作最後幾行。
  - 只有 1 個在跑：顯示它的完整內容。
  - 都跑完：顯示最後有動靜的那一筆。
- **釘選**：用滑鼠點上半部某一行，下半部就固定顯示那一筆（📌），再點一次取消。用鍵盤的話，按 `ctrl+x tab` 讓 pane 接手鍵盤，再按 `1`～`9` 釘選、`f` 取消，Esc 回到輸入框。
- **輪詢時間**：最上面的 `polled 12:01:03` 是最後一次輪詢完成的時間。這個時間沒在動，表示輪詢停了；時間有動但內容沒變，才是 Codex 沒寫東西。
- **狀態列**：`Codex ● 2 running · 3 sent`。有 rollout 讀取失敗時，後面會加上 `⚠` 和錯誤訊息，其他 thread 照常更新。
- **Toast**：每個 turn 完成或出錯時提醒。

指令只顯示真正執行的內容和結束碼（`✓` / `✗ exit 1`）；Codex 的推理過程在 rollout 裡是加密的，不會顯示。

## 需求

- Windows 10 / 11
- [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows)（`pwsh` 在 PATH 上）
- 支援 mod（plugin function hooks）的 Claude Code，在 2.1.289 上開發與測試
- [Codex CLI](https://github.com/openai/codex)，在 0.160.0 上測試
- 選用：[codex plugin](https://github.com/openai/codex-plugin-cc)、[claude-codex-bridge](https://github.com/ar36planet/claude-codex-bridge-public)（要監控它們派送的工作時才需要）

## 安裝

1. Clone 到任意位置：

   ```powershell
   git clone https://github.com/ar36planet/mod-codex-monitor.git C:\Workspace\Glab\github\codex-monitor
   ```

2. 在 `%USERPROFILE%\.claude\settings.json` 的 `env` 加上這個資料夾（必須是使用者層級的 settings，專案的 settings 不會讀這個變數）：

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Workspace\\Glab\\github\\codex-monitor"
     }
   }
   ```

   已經有其他 mod 時，用 `;` 分隔多個路徑。

3. 重開 Claude Code，輸入 `/codex-monitor` 開啟 pane。

只想在某一次啟動時試用，也可以改用 `claude --plugin-dir C:\Workspace\Glab\github\codex-monitor`。

## 使用

| 指令 | 作用 |
| --- | --- |
| `/codex-monitor` | 開啟 pane |
| `/codex-monitor clear` | 清空追蹤清單（codex plugin 的 job 會在下次輪詢時依 `state.json` 加回來） |

每 3 秒檢查一次，所以畫面大約有 3 秒延遲。只在 Claude Code 開著時運作。

rollout 是增量讀取：記住上次讀到的位置，每輪只讀新增的部分，每次最多 2 MiB，沒讀完的下一輪接著讀。剛開始追蹤一個很大的 rollout 時，要幾輪才會補讀完。超過 1 MiB 的檔案透過 `pwsh` 跳到上次的位置讀取。

## 限制

- **只支援 Windows。** 見上方說明。
- **Rollout 格式不是公開規格。** Codex 升版可能改欄位；解析器遇到不認得的欄位會略過該行。
- **`codex exec` 的提示詞不在指令裡時**（例如從 stdin 或檔案傳入），只能依啟動時間配對；同一時間在別處手動跑的 `codex exec` 可能被誤認。超過 60 秒仍找不到 rollout 的 exec 會標成 `no rollout found`。
- **超過 2 MiB 的單行會略過。** 通常是極大的工具輸出，略過後從下一行繼續讀。
- **codex plugin 的 job** 以 `%USERPROFILE%\.claude\plugins\data\codex-openai-codex\state` 與 `%TEMP%\codex-companion` 為準；plugin 改了存放位置就要跟著改。

## 開發

```text
.claude-plugin/plugin.json   manifest
hooks/hooks.json             指向 register.tsx
hooks/register.tsx           hooks：輪詢、tool.call 攔截、指令、pane 繪製
hooks/sources.ts             追蹤來源：plugin job、exec 偵測與配對、bridge thread id
hooks/reader.ts              rollout 的增量讀取：從一批 bytes 切出完整的行
hooks/parse.ts               rollout JSONL → 畫面上的每一行（可分批餵入）
types/index.d.ts             $.state 的型別合約
```

透過 `CLAUDE_CODE_PLUGIN_DIRS` 載入時，開著的 session 會在檔案變更後自動重新載入。

```powershell
claude plugin validate .   # 檢查 manifest 與 hooks
claude plugin test .       # 執行 hooks/*.test.ts
npx -p typescript@5 tsc -p .   # 型別檢查（tsconfig 在第一次載入後由 Claude Code 產生）
```

## 授權

[MIT](LICENSE)
