import type { Tracked } from '../types'

const THREAD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

export const EMPTY_ROLLOUT = { command: '', lastLine: '', cwd: '', file: '' }

// codex plugin 的 state.json：只取這個 Claude session 派的 job
export function jobsOfSession(stateJson: string, sessionId: string): Tracked[] {
  let state: any
  try {
    state = JSON.parse(stateJson)
  } catch {
    return []
  }
  if (!Array.isArray(state?.jobs)) return []

  return state.jobs
    .filter((job: any) => job?.sessionId === sessionId && typeof job.id === 'string')
    .map(
      (job: any): Tracked => ({
        ...EMPTY_ROLLOUT,
        key: `plugin:${job.id}`,
        source: 'plugin',
        title: String(job.kindLabel ?? job.title ?? 'task'),
        threadId: typeof job.threadId === 'string' ? job.threadId : '',
        status: [job.status, job.phase].filter(Boolean).join(' · ') || 'queued',
        isRunning: job.status === 'running' || job.status === 'queued',
        startedAt: Date.parse(job.createdAt ?? '') || 0,
        updatedAt: Date.parse(job.updatedAt ?? job.createdAt ?? '') || 0,
      }),
    )
}

// Bash / PowerShell 直接下的 codex exec（含 codex.exe、codex.cmd、npx codex 與簡寫 e）
const CODEX_EXEC = /(^|[\s;&|("'`\\/])(npx\s+(-y\s+)?(@openai\/)?)?codex(\.exe|\.cmd|\.ps1)?["']?\s+(exec|e)(?=\s|$)/gi

// 一個指令裡有幾個 codex exec；引號裡的字（echo、commit 訊息、提示詞）不算，
// 但保留加引號的 codex 執行檔路徑
export function countCodexExecs(command: unknown): number {
  if (typeof command !== 'string') return 0
  const bare = command
    .replace(/(["'])[^"']*?[\\/]?codex(\.exe|\.cmd|\.ps1)?\1/gi, ' codex ')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ' "" ')

  return [...bare.matchAll(CODEX_EXEC)].length
}

export function isCodexExec(command: unknown): boolean {
  return countCodexExecs(command) > 0
}

// rollout-2026-10-02T11-09-56-<thread>.jsonl：檔名時間是本地時間
export function rolloutName(name: string): { startedAt: number; threadId: string } | undefined {
  const match = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/)
  if (!match) return undefined
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = match.slice(1, 7).map(Number)
  const threadId = match[7] ?? ''
  const startedAt = new Date(y, mo - 1, d, h, mi, s).getTime()

  return { startedAt, threadId }
}

export function isExecRollout(firstLine: string): boolean {
  try {
    const meta = JSON.parse(firstLine)?.payload ?? {}
    return meta.source === 'exec' || meta.originator === 'codex_exec'
  } catch {
    return false
  }
}

// 比對用：去掉引號、跳脫與多餘空白；只取開頭，長提示詞在 shell 裡可能被換行或截斷
function promptKey(text: string | undefined): string {
  return String(text ?? '')
    .replace(/[\\"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 60)
}

export type ExecWaiting = { key: string; startedAt: number; command: string }
export type ExecCandidate = { threadId: string; startedAt: number; prompt: string; ageMs: number }

// 檔名時間只到秒，且 exec 啟動到建檔之間有落差
const SLACK_MS = 5000
// 提示詞不在指令裡（stdin、檔案）時，等這麼久沒有文字對上才改用時間配對
const TEXT_GRACE_MS = 8000

// 先用提示詞文字配對；對不上的才依時間順序配
export function matchExecs(waiting: readonly ExecWaiting[], candidates: readonly ExecCandidate[]): Map<string, string> {
  const found = new Map<string, string>()
  const open = [...waiting].sort((a, b) => a.startedAt - b.startedAt)
  const pool = [...candidates].sort((a, b) => a.startedAt - b.startedAt)
  const isTaken = (exec: ExecWaiting) => found.has(exec.key)
  const canOwn = (exec: ExecWaiting, file: ExecCandidate) => file.startedAt >= exec.startedAt - SLACK_MS

  const leftover: ExecCandidate[] = []
  for (const file of pool) {
    const key = file.prompt ? promptKey(file.prompt) : ''
    const owner = key
      ? open.find(exec => !isTaken(exec) && canOwn(exec, file) && promptKey(exec.command).includes(key))
      : undefined
    if (owner) found.set(owner.key, file.threadId)
    else leftover.push(file)
  }

  for (const file of leftover) {
    if (file.ageMs < TEXT_GRACE_MS) continue
    const key = file.prompt ? promptKey(file.prompt) : ''
    // 指令裡看得到別的提示詞的 exec，不拿來接沒對上的檔
    const owner = open.find(
      exec => !isTaken(exec) && canOwn(exec, file) && !(key && pool.some(other => other !== file && other.prompt && promptKey(exec.command).includes(promptKey(other.prompt)))),
    )
    if (owner) found.set(owner.key, file.threadId)
  }

  return found
}

// bridge 的 codex_message_send：thread id 在輸入或結果裡
export function threadOfBridgeSend(input: unknown, result: unknown): string {
  const given = (input as { threadId?: unknown } | undefined)?.threadId
  if (typeof given === 'string' && THREAD_ID.test(given)) return given
  const text = JSON.stringify(result ?? '')
  const named = text.match(/thread(?:Id)?\W{1,6}([0-9a-f]{8}-[0-9a-f-]{27})/i)

  return named?.[1] ?? text.match(THREAD_ID)?.[0] ?? ''
}
