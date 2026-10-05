import type { Entry } from '../types'

export type Parsed = {
  entries: Entry[]
  cwd: string
  isRunning: boolean
  lastCompleted?: { turnId: string; text: string; isError: boolean }
}

const MAX_ENTRIES = 300

function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function clockTime(timestamp: unknown): string {
  if (typeof timestamp !== 'string') return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part => (part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

// CommandExecution 的 command 是 [shell, -Command, 指令]；parsed_cmd 有拆好的指令
function commandOf(item: any): string {
  const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map((one: any) => one?.cmd).filter(Boolean) : []
  if (parsed.length > 0) return parsed.join(' ; ')
  const argv: string[] = Array.isArray(item.command) ? item.command.map(String) : [String(item.command ?? '')]
  const flag = argv.findIndex(arg => /^-(c|Command)$/i.test(arg))

  return (flag >= 0 ? argv.slice(flag + 1) : argv).join(' ')
}

function firstLine(text: unknown): string {
  return typeof text === 'string' ? (text.split(/\r?\n/).find(line => line.trim()) ?? '') : ''
}

// Codex 的 rollout 格式不是公開規格，欄位缺了就略過該行。
// 以 event_msg/item_completed 為主（真正的指令與回覆）；
// response_item 的工具呼叫是 JS 包裝與 JSON 輸出，只在沒有 item_completed 的舊格式才用。
export function parseRollout(jsonl: string): Parsed {
  const rows: any[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // 讀檔尾時切到半行
    }
  }
  const hasItems = rows.some(row => row?.type === 'event_msg' && row.payload?.type === 'item_completed')

  const entries: Entry[] = []
  let cwd = ''
  let isRunning = false
  let lastCompleted: Parsed['lastCompleted']

  for (const row of rows) {
    const p = row?.payload ?? {}
    const time = clockTime(row?.timestamp)
    const push = (kind: Entry['kind'], text: string) => {
      if (text) entries.push({ kind, text, time })
    }

    if (row.type === 'session_meta' || row.type === 'turn_context') {
      if (typeof p.cwd === 'string') cwd = p.cwd
    } else if (row.type === 'event_msg') {
      if (p.type === 'task_started') {
        isRunning = true
        push('turn', '── turn started ──')
      } else if (p.type === 'task_complete') {
        isRunning = false
        const error = p.error?.message
        const secs = typeof p.duration_ms === 'number' ? ` (${Math.round(p.duration_ms / 1000)}s)` : ''
        if (error) push('error', oneLine(error, 400))
        push('turn', `── turn complete${secs} ──`)
        lastCompleted = {
          turnId: String(p.turn_id ?? ''),
          text: oneLine(error ?? p.last_agent_message ?? 'done', 120),
          isError: Boolean(error),
        }
      } else if (p.type === 'item_completed') {
        const item = p.item ?? {}
        if (item.type === 'UserMessage') {
          push('user', textOf(item.content).trim())
        } else if (item.type === 'AgentMessage') {
          push('codex', textOf(item.content).trim())
        } else if (item.type === 'CommandExecution') {
          const code = item.exit_code
          const isOk = code === 0 || code === undefined || code === null
          push('tool', `${isOk ? '✓' : `✗ exit ${code}`}  ${oneLine(commandOf(item), 180)}`)
          if (!isOk) push('output', oneLine(firstLine(item.stderr) || firstLine(item.aggregated_output), 160))
        }
      }
    } else if (row.type === 'response_item' && !hasItems) {
      if (p.type === 'message' && p.role === 'assistant') {
        push('codex', textOf(p.content).trim())
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        push('tool', [p.namespace, p.name].filter(Boolean).join('.') || 'tool')
      }
    }
  }

  return { entries: entries.slice(-MAX_ENTRIES), cwd, isRunning, lastCompleted }
}
