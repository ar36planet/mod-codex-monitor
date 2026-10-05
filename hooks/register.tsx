import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Tracked } from '../types'
import { parseRollout } from './parse'
import type { Parsed } from './parse'
import {
  EMPTY_ROLLOUT,
  countCodexExecs,
  isExecRollout,
  jobsOfSession,
  matchExecs,
  rolloutName,
  threadOfBridgeSend,
} from './sources'
import type { ExecCandidate } from './sources'

const PANE = 'codex-monitor'
const POLL_MS = 3000
// $.fs.read 上限 4 MiB；超過這個大小改用 pwsh 只讀檔尾
const WHOLE_READ_LIMIT = 1024 * 1024
const FS_READ_MAX = 4 * 1024 * 1024
const TAIL_LINES = 400
const SLACK_MS = 5000
const LOG_ENTRIES = 200
// 清單用數字鍵 1–9 釘選，最多顯示 9 筆
const LIST_ROWS = 9
// 同時執行時最多分幾格
const MAX_SPLIT = 4
const BRIDGE_SEND = 'mcp__claude-codex-bridge__codex_message_send'

const tracked = atom({ plugin: 'codex-monitor', key: 'tracked' } as const, [])
const logs = atom({ plugin: 'codex-monitor', key: 'logs' } as const, {})
const view = atom({ plugin: 'codex-monitor', key: 'view' } as const, { latestKey: '', pinned: '' })

const COLORS: Record<Entry['kind'], string | undefined> = {
  user: 'cyan',
  codex: undefined,
  tool: 'yellow',
  output: undefined,
  turn: 'magenta',
  error: 'red',
}

const LABELS: Record<Entry['kind'], string> = {
  user: 'ask  ',
  codex: 'codex',
  tool: 'tool ',
  output: '  ↳  ',
  turn: '     ',
  error: 'error',
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, Math.max(1, max - 1)) + '…' : flat
}

// 在 next 之前登記，背景執行或跑很久的 exec 也能馬上出現在清單；
// 一個指令裡有幾個 codex exec 就登記幾筆
async function trackExec($: EngineInterface, command: string) {
  const count = countCodexExecs(command)
  if (count === 0) return
  const now = await $.clock.now()
  const added: Tracked[] = Array.from({ length: count }, (_, index) => ({
    ...EMPTY_ROLLOUT,
    key: `exec:${now}:${index}`,
    source: 'exec',
    title: count > 1 ? `exec ${index + 1}/${count}` : 'exec',
    threadId: '',
    status: 'starting',
    isRunning: true,
    startedAt: now,
    updatedAt: now,
    command,
  }))
  await update($, tracked, list => [...list, ...added])
}

export const register: Register = on => {
  // 模組重載時這些快取會清空，追蹤清單本身在 $.state 裡不受影響
  const rolloutPaths = new Map<string, string>()
  const rollouts = new Map<string, { mtime: number; size: number; changedAt: number; parsed: Parsed }>()
  const toastedTurns = new Map<string, string>()
  const notExec = new Set<string>()
  let isBusy = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'codex-monitor',
      description: 'Show the Codex work this session sent out (args: clear)',
    })

    const sessionId = await $.session.id()
    const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
    const temp = ((await $.env.get('TEMP')) ?? '').replace(/\\/g, '/')
    const sessionsRoot = `${home}/.codex/sessions`
    const jobRoots = [`${home}/.claude/plugins/data/codex-openai-codex/state`, `${temp}/codex-companion`]

    const listDirs = async (dir: string) => {
      try {
        return (await $.fs.list(dir)).filter(one => one.kind === 'dir').map(one => one.name)
      } catch {
        return []
      }
    }

    // sessions/YYYY/MM/DD：由新到舊取 count 個日期資料夾
    const newestDays = async (count: number): Promise<string[]> => {
      const days: string[] = []
      for (const y of (await listDirs(sessionsRoot)).sort().reverse()) {
        for (const m of (await listDirs(`${sessionsRoot}/${y}`)).sort().reverse()) {
          for (const d of (await listDirs(`${sessionsRoot}/${y}/${m}`)).sort().reverse()) {
            days.push(`${sessionsRoot}/${y}/${m}/${d}`)
            if (days.length >= count) return days
          }
        }
      }

      return days
    }

    const readText = async (path: string, size: number) => {
      if (size <= WHOLE_READ_LIMIT) return $.fs.read(path)
      const quoted = path.replace(/'/g, "''")
      const ran = await $.process.run([
        'pwsh',
        '-NoProfile',
        '-Command',
        // pwsh 輸出到 pipe 時預設用系統字碼頁（繁中 Windows 是 Big5），中文會變亂碼
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Content -LiteralPath '${quoted}' -Tail ${TAIL_LINES} -Encoding utf8`,
      ])

      return ran.stdout
    }

    const pluginJobs = async (): Promise<Tracked[]> => {
      const jobs: Tracked[] = []
      for (const root of jobRoots) {
        for (const dir of await listDirs(root)) {
          try {
            jobs.push(...jobsOfSession(await $.fs.read(`${root}/${dir}/state.json`), sessionId))
          } catch {
            // 沒有 state.json 的工作區
          }
        }
      }

      return jobs
    }

    // 為還沒有 thread 的 exec 找它開的 rollout 檔：讀出提示詞交給 matchExecs
    const findExecThreads = async (list: Tracked[], now: number) => {
      const waiting = list.filter(one => one.source === 'exec' && !one.threadId)
      if (waiting.length === 0) return new Map<string, string>()
      const claimed = new Set(list.map(one => one.threadId).filter(Boolean))
      const earliest = Math.min(...waiting.map(one => one.startedAt)) - SLACK_MS
      const candidates: ExecCandidate[] = []
      for (const day of await newestDays(2)) {
        for (const file of await $.fs.list(day)) {
          const named = file.kind === 'file' ? rolloutName(file.name) : undefined
          if (!named || named.startedAt < earliest) continue
          if (claimed.has(named.threadId) || notExec.has(named.threadId) || file.size > FS_READ_MAX) continue
          const path = `${day}/${file.name}`
          const text = await $.fs.read(path)
          if (!isExecRollout(text.split('\n', 1)[0] ?? '')) {
            notExec.add(named.threadId)
            continue
          }
          rolloutPaths.set(named.threadId, path)
          const prompt = parseRollout(text).entries.find(entry => entry.kind === 'user')?.text ?? ''
          candidates.push({ ...named, prompt, ageMs: now - named.startedAt })
        }
      }

      return matchExecs(waiting, candidates)
    }

    const findRollout = async (threadId: string) => {
      const known = rolloutPaths.get(threadId)
      if (known) return known
      for (const day of await newestDays(7)) {
        const hit = (await $.fs.list(day)).find(file => file.name.endsWith(`${threadId}.jsonl`))
        if (hit) {
          rolloutPaths.set(threadId, `${day}/${hit.name}`)
          return `${day}/${hit.name}`
        }
      }

      return undefined
    }

    // 讀有變動的 rollout；回傳最近一次看到它變動的時間（沒有 rollout 為 0）。
    // Windows 上 Codex 寫 rollout 時 mtime 停在建檔時間，只有大小會變，所以兩者都比。
    const refreshRollout = async (one: Tracked, now: number) => {
      const path = one.threadId ? await findRollout(one.threadId) : undefined
      if (!path) return 0
      const stat = await $.fs.stat(path)
      const cached = rollouts.get(one.threadId)
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.changedAt
      const parsed = parseRollout(await readText(path, stat.size))
      rollouts.set(one.threadId, { mtime: stat.mtimeMs, size: stat.size, changedAt: now, parsed })

      const done = parsed.lastCompleted
      const seen = toastedTurns.get(one.threadId)
      if (done && done.turnId !== seen) {
        // 第一次看到這條 thread 只記住，不為舊 turn 跳 toast
        if (cached) $.ui.toast(`Codex ${done.isError ? '✗' : '✓'} ${one.title}: ${done.text}`)
        toastedTurns.set(one.threadId, done.turnId)
      }

      return now
    }

    // 把 rollout 的內容填回追蹤項目
    const withRollout = (one: Tracked, now: number): Tracked => {
      if (one.source === 'exec' && !one.threadId && now - one.startedAt > 60_000) {
        return { ...one, isRunning: false, status: 'no rollout found' }
      }
      const parsed = one.threadId ? rollouts.get(one.threadId)?.parsed : undefined
      if (!parsed) return one
      const last = parsed.entries.at(-1)
      const prompt = parsed.entries.find(entry => entry.kind === 'user')?.text ?? ''
      const filled: Tracked = {
        ...one,
        lastLine: last ? `${last.kind === 'codex' ? 'codex: ' : ''}${oneLine(last.text, 160)}` : '',
        cwd: parsed.cwd,
        file: rolloutPaths.get(one.threadId)?.split('/').pop() ?? '',
        title: one.source === 'exec' && prompt ? `exec ${oneLine(prompt, 40)}` : one.title,
      }
      if (one.source === 'plugin') return filled

      return { ...filled, isRunning: parsed.isRunning, status: parsed.isRunning ? 'running' : 'idle' }
    }

    const poll = async () => {
      if (isBusy) return
      isBusy = true
      try {
        const now = await $.clock.now()
        const jobs = await pluginJobs()
        const current = await read($, tracked)
        const execThreads = await findExecThreads(current, now)

        const merged: Tracked[] = [
          ...current
            .filter(one => one.source !== 'plugin')
            .map(one => (execThreads.has(one.key) ? { ...one, threadId: execThreads.get(one.key) ?? '' } : one)),
          ...jobs.map(job => ({ ...job, ...pick(current.find(one => one.key === job.key)) })),
        ]

        const changedAt = new Map<string, number>()
        for (const one of merged) changedAt.set(one.key, await refreshRollout(one, now))
        const filled = merged.map(one => withRollout(one, now))

        await update($, tracked, list => {
          const fresh = new Map(filled.map(one => [one.key, one]))
          // 輪詢期間 hook 新加的項目要保留
          const added = list.filter(one => one.source !== 'plugin' && !fresh.has(one.key))
          return [...filled, ...added].sort((a, b) => a.startedAt - b.startedAt).slice(-30)
        })

        const nextLogs: Record<string, Entry[]> = {}
        for (const one of filled) {
          const parsed = one.threadId ? rollouts.get(one.threadId)?.parsed : undefined
          if (parsed) nextLogs[one.key] = parsed.entries.slice(-LOG_ENTRIES)
        }
        await update($, logs, () => nextLogs)

        const latest = filled
          .filter(one => (changedAt.get(one.key) ?? 0) > 0)
          .sort((a, b) => (changedAt.get(b.key) ?? 0) - (changedAt.get(a.key) ?? 0))[0]
        if (latest) await update($, view, shown => ({ ...shown, latestKey: latest.key }))

        const running = filled.filter(one => one.isRunning).length
        $.ui.status(
          filled.length === 0
            ? undefined
            : `Codex ${running > 0 ? `● ${running} running` : '○ idle'} · ${filled.length} sent`,
        )
      } catch (error) {
        $.ui.status(`codex-monitor: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        isBusy = false
      }
    }

    // plugin job 每次從 state.json 重建，保留上次從 rollout 填入的欄位
    const pick = (old: Tracked | undefined) =>
      old ? { lastLine: old.lastLine, cwd: old.cwd, file: old.file } : {}

    void poll()
    $.clock.every(POLL_MS, () => void poll())

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await trackExec($, e.command)
    return next(e)
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    await trackExec($, e.command)
    return next(e)
  })

  on('tool.call', { tool: BRIDGE_SEND }, async ($, e, next) => {
    const ran = await next(e)
    const threadId = threadOfBridgeSend(e, ran.result)
    if (!threadId) return ran
    const now = await $.clock.now()
    await update($, tracked, list =>
      list.some(one => one.key === `bridge:${threadId}`)
        ? list
        : [
            ...list,
            {
              ...EMPTY_ROLLOUT,
              key: `bridge:${threadId}`,
              source: 'bridge' as const,
              title: `bridge ${threadId.slice(0, 8)}`,
              threadId,
              status: 'sent',
              isRunning: true,
              startedAt: now,
              updatedAt: now,
            },
          ],
    )

    return ran
  })

  on('command.run', { command: 'codex-monitor' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      // plugin job 由 state.json 決定，下次輪詢會再加回來
      await update($, tracked, () => [])
      await update($, logs, () => ({}))
      await update($, view, () => ({ latestKey: '', pinned: '' }))

      return { text: 'Codex monitor cleared.' }
    }
    await $.ui.open({ id: PANE, title: 'Codex monitor' })

    return { text: 'Codex monitor opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, tracked)
    const allLogs = await read($, logs)
    const shown = await read($, view)

    if (list.length === 0) {
      return <Text dimColor>This session has not sent anything to Codex yet.</Text>
    }

    const rows = list.slice(-LIST_ROWS)
    const pinned = list.some(one => one.key === shown.pinned) ? shown.pinned : ''
    const running = list.filter(one => one.isRunning && allLogs[one.key])
    // 不用按鍵：有釘選就只看那一筆；同時跑好幾個就分格各看最後幾行；否則看最新的一筆
    const sections = pinned
      ? list.filter(one => one.key === pinned)
      : running.length > 1
        ? running.slice(-MAX_SPLIT)
        : list.filter(one => one.key === (running[0]?.key ?? shown.latestKey))
    const isSplit = sections.length > 1
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 6)
    const room = Math.max(sections.length * 3, (e.viewport?.rows ?? 24) - rows.length - 4)
    const perSection = Math.max(2, Math.floor(room / Math.max(1, sections.length)) - 1)
    const setPinned = (key: string) => void update($, view, current => ({ ...current, pinned: key }))

    const entryRow = (entry: Entry) => {
      // 分格時每筆固定一行，各格高度才可預期
      const isProse = (entry.kind === 'codex' || entry.kind === 'user') && !isSplit

      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>{entry.time}</Text>
          <Text color={COLORS[entry.kind]} bold={entry.kind !== 'output'}>
            {LABELS[entry.kind]}
          </Text>
          <Text
            color={entry.kind === 'error' ? 'red' : undefined}
            dimColor={entry.kind === 'output'}
            wrap={isProse ? 'wrap' : 'truncate-end'}
          >
            {isProse ? entry.text.slice(0, 1200) : entry.text.replace(/\s+/g, ' ')}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {rows.map((one, index) => (
          <Button
            key={`row-${one.key}`}
            plain
            hotkey={String(index + 1)}
            dimColor={!one.isRunning && one.key !== pinned}
            label={oneLine(
              `${one.key === pinned ? '📌' : ''}${one.isRunning ? '●' : '○'} [${one.source}] ${one.title} · ${one.lastLine || one.status}`,
              width,
            )}
            onPress={() => setPinned(one.key === pinned ? '' : one.key)}
          />
        ))}
        {pinned && <Button key="unpin" plain hotkey="f" label="show all again" onPress={() => setPinned('')} />}
        {sections.map(one => (
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-middle">
              ── {one.isRunning ? '●' : '○'} {one.title} · {one.cwd || one.status} ──
            </Text>
            {(allLogs[one.key] ?? []).slice(isSplit ? -perSection : -room).map(entryRow)}
          </Box>
        ))}
      </Box>
    )
  })
}
