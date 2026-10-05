export type EntryKind = 'user' | 'codex' | 'tool' | 'output' | 'turn' | 'error'
export type Entry = { kind: EntryKind; text: string; time: string }

// 這個 Claude session 派出去的一條 Codex thread
export type Tracked = {
  key: string
  source: 'plugin' | 'bridge' | 'exec'
  title: string
  // exec 剛啟動、還沒對上 rollout 檔時為空字串
  threadId: string
  // plugin job 的 status/phase；bridge 與 exec 由 rollout 推得
  status: string
  isRunning: boolean
  startedAt: number
  updatedAt: number
  // exec：派出它的整段 shell 指令，用來比對 rollout 裡的提示詞
  command: string
  // rollout 最新的一行動態、工作目錄與檔名
  lastLine: string
  cwd: string
  file: string
}

// latestKey：最近有動靜的一筆；pinned：使用者釘選的一筆，空字串表示跟著最新
export type View = { latestKey: string; pinned: string }

declare module 'claude-code' {
  interface PluginState {
    // polledAt：最後一次輪詢完成的時間（ms）；scrollBack：log 區往回捲了幾列，0 表示跟著最新
    'codex-monitor': { tracked: Tracked[]; logs: Record<string, Entry[]>; view: View; polledAt: number; scrollBack: number }
  }
}
