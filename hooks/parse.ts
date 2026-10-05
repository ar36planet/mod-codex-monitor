import type { Entry } from '../types'

export type Parsed = {
  entries: Entry[]
  cwd: string
  isRunning: boolean
  lastCompleted?: { turnId: string; text: string; isError: boolean }
  // 看過 item_completed 就是新格式，response_item 的項目不再顯示
  hasItems: boolean
}

const MAX_ENTRIES = 300
// 從 response_item 來的項目；確定是新格式時要拿掉
const fromResponse = new WeakSet<Entry>()

export function emptyParsed(): Parsed {
  return { entries: [], cwd: '', isRunning: false, hasItems: false }
}

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
  return feedRollout(emptyParsed(), jsonl)
}

// 把新讀到的幾行接在 parsed 後面（直接改動 parsed）
export function feedRollout(parsed: Parsed, jsonl: string): Parsed {
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      // 不完整或壞掉的一行
      continue
    }
    const p = row?.payload ?? {}
    const time = clockTime(row?.timestamp)
    const push = (kind: Entry['kind'], text: string) => {
      if (!text) return
      const entry = { kind, text, time }
      if (row.type === 'response_item') fromResponse.add(entry)
      parsed.entries.push(entry)
    }

    if (row?.type === 'event_msg' && p.type === 'item_completed' && !parsed.hasItems) {
      parsed.hasItems = true
      parsed.entries = parsed.entries.filter(entry => !fromResponse.has(entry))
    }

    if (row.type === 'session_meta' || row.type === 'turn_context') {
      if (typeof p.cwd === 'string') parsed.cwd = p.cwd
    } else if (row.type === 'event_msg') {
      if (p.type === 'task_started') {
        parsed.isRunning = true
        push('turn', '── turn started ──')
      } else if (p.type === 'task_complete') {
        parsed.isRunning = false
        const error = p.error?.message
        const secs = typeof p.duration_ms === 'number' ? ` (${Math.round(p.duration_ms / 1000)}s)` : ''
        if (error) push('error', oneLine(error, 400))
        push('turn', `── turn complete${secs} ──`)
        parsed.lastCompleted = {
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
    } else if (row.type === 'response_item' && !parsed.hasItems) {
      if (p.type === 'message' && p.role === 'assistant') {
        push('codex', textOf(p.content).trim())
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        push('tool', [p.namespace, p.name].filter(Boolean).join('.') || 'tool')
      }
    }
  }
  if (parsed.entries.length > MAX_ENTRIES) parsed.entries = parsed.entries.slice(-MAX_ENTRIES)

  return parsed
}
