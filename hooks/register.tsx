import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Tracked } from '../types'
import { clipWidth, scrollEntries, wrappedRows } from './layout'
import { emptyParsed, feedRollout, parseRollout } from './parse'
import type { Parsed } from './parse'
import { START, takeLines } from './reader'
import type { Cursor } from './reader'
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
// 不超過這個大小的 rollout 用 $.fs.read 整個讀再切；更大的用 pwsh 跳到上次的位置只讀新的部分
const WHOLE_READ_LIMIT = 1024 * 1024
// $.fs.read 上限 4 MiB
const FS_READ_MAX = 4 * 1024 * 1024
// 每輪每個 rollout 最多讀這麼多，沒讀完的下一輪接著讀；base64 後仍在 stdout 的 4 MiB 上限內
const BATCH_BYTES = 2 * 1024 * 1024
const SLACK_MS = 5000
const LOG_ENTRIES = 200
// 一則回覆最多顯示這麼多字
const PROSE_CHARS = 1200
// 清單用數字鍵 1–9 釘選，最多顯示 9 筆
const LIST_ROWS = 9
// 同時執行時最多分幾格
const MAX_SPLIT = 4
const BRIDGE_SEND = 'mcp__claude-codex-bridge__codex_message_send'

const tracked = atom({ plugin: 'codex-monitor', key: 'tracked' } as const, [])
const logs = atom({ plugin: 'codex-monitor', key: 'logs' } as const, {})
const view = atom({ plugin: 'codex-monitor', key: 'view' } as const, { latestKey: '', pinned: '' })
const polledAt = atom({ plugin: 'codex-monitor', key: 'polledAt' } as const, 0)
const scrollBack = atom({ plugin: 'codex-monitor', key: 'scrollBack' } as const, 0)

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

const clockTime = (ms: number) => {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const fromBase64 = (base64: string) => {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)

  return bytes
}

// 在 next 之前登記，背景執行或跑很久的 exec 也能馬上出現在清單；
// 一個指令裡有幾個 codex exec 就登記幾筆
async function trackExec($: EngineInterface, command: unknown) {
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
    command: String(command),
  }))
  await update($, tracked, list => [...list, ...added])
}

export const register: Register = on => {
  // 模組重載時這些快取會清空，追蹤清單本身在 $.state 裡不受影響
  const rolloutPaths = new Map<string, string>()
  // isCaughtUp：上一次讀已經讀到檔尾（之後完成的 turn 才跳 toast）
  const rollouts = new Map<string, { cursor: Cursor; parsed: Parsed; changedAt: number; isCaughtUp: boolean }>()
  const toastedTurns = new Map<string, string>()
  const notExec = new Set<string>()
  let isBusy = false
  // 上次畫的 log 區最多能往回捲幾列，給 ui.scroll 夾住捲動範圍
  let maxBack = 0

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

    // 讀 [offset, offset + length) 這段 bytes。傳 base64 而不是文字，避開 pwsh 輸出的字碼頁問題
    const readBytes = async (path: string, offset: number, length: number, size: number) => {
      if (size <= WHOLE_READ_LIMIT) {
        const { base64 } = await $.fs.read(path, { as: 'bytes' })
        return fromBase64(base64).subarray(offset, offset + length)
      }
      const quoted = path.replace(/'/g, "''")
      const ran = await $.process.run([
        'pwsh',
        '-NoProfile',
        '-Command',
        // Codex 還開著檔案在寫，要允許共用
        `$f = [IO.File]::Open('${quoted}', 'Open', 'Read', 'ReadWrite, Delete'); ` +
          `try { [void]$f.Seek(${offset}, 'Begin'); $b = [byte[]]::new(${length}); $n = 0; ` +
          `while ($n -lt ${length}) { $r = $f.Read($b, $n, ${length} - $n); if ($r -le 0) { break }; $n += $r }; ` +
          `[Console]::Out.Write([Convert]::ToBase64String($b, 0, $n)) } finally { $f.Dispose() }`,
      ])
      if (ran.exitCode !== 0) throw new Error(`reading ${path.split('/').pop()}: ${oneLine(ran.stderr, 160)}`)

      return fromBase64(ran.stdout.trim())
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

    // 從上次讀到的位置往後讀一批新的行；回傳最近一次讀到新內容的時間（沒有 rollout 為 0）。
    // Windows 上 Codex 寫 rollout 時 mtime 停在建檔時間，所以只看大小。
    const refreshRollout = async (one: Tracked, now: number) => {
      const path = one.threadId ? await findRollout(one.threadId) : undefined
      if (!path) return 0
      const { size } = await $.fs.stat(path)
      let state = rollouts.get(one.threadId)
      // 檔案變短表示被重寫，從頭讀
      if (!state || size < state.cursor.offset) {
        state = { cursor: START, parsed: emptyParsed(), changedAt: 0, isCaughtUp: false }
        rollouts.set(one.threadId, state)
      }
      if (size === state.cursor.offset) return state.changedAt

      const length = Math.min(BATCH_BYTES, size - state.cursor.offset)
      const taken = takeLines(await readBytes(path, state.cursor.offset, length, size), state.cursor, BATCH_BYTES)
      const wasCaughtUp = state.isCaughtUp
      state.isCaughtUp = state.cursor.offset + length >= size
      state.cursor = taken.cursor
      if (!taken.text) return state.changedAt
      feedRollout(state.parsed, taken.text)
      state.changedAt = now

      const done = state.parsed.lastCompleted
      if (done && done.turnId !== toastedTurns.get(one.threadId)) {
        // 補讀舊內容時只記住，不為舊 turn 跳 toast
        if (wasCaughtUp) $.ui.toast(`Codex ${done.isError ? '✗' : '✓'} ${one.title}: ${done.text}`)
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

        // 一條 thread 讀失敗不影響其他條
        const changedAt = new Map<string, number>()
        const failures: string[] = []
        for (const one of merged) {
          try {
            changedAt.set(one.key, await refreshRollout(one, now))
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error))
            changedAt.set(one.key, rollouts.get(one.threadId)?.changedAt ?? 0)
          }
        }
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
        await update($, polledAt, () => now)
        // state 更新本來就會重畫；這裡再明確要求一次，避免 pane 停在舊畫面
        $.ui.invalidate('ui.render')

        const running = filled.filter(one => one.isRunning).length
        const failed = failures.length > 0 ? ` · ⚠ ${oneLine(failures[0] ?? '', 80)}` : ''
        $.ui.status(
          filled.length === 0
            ? undefined
            : `Codex ${running > 0 ? `● ${running} running` : '○ idle'} · ${filled.length} sent${failed}`,
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
      await update($, scrollBack, () => 0)

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
    const lastPoll = await read($, polledAt)
    const wantBack = await read($, scrollBack)

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
    const width = Math.max(20, e.props.bodyColumns ?? (e.viewport?.columns ?? 80) - 6)
    // 時間 8 格、標籤 5 格，加上兩個間隔
    const textColumns = Math.max(10, width - 15)
    // 分格時每筆固定一行，各格高度才可預期
    const isProse = (entry: Entry) => (entry.kind === 'codex' || entry.kind === 'user' || entry.kind === 'error') && !isSplit
    const rowsOf = (entry: Entry) => (isProse(entry) ? wrappedRows(entry.text.slice(0, PROSE_CHARS), textColumns) : 1)
    // 上面一列輪詢時間、下面是各工作的狀態，中間的 log 區自己捲動，整個畫面剛好是 pane 的高度
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    // 工作清單加一列翻頁按鈕
    const footerRows = rows.length + 1
    const logRows = Math.max(sections.length * 2, bodyRows - 1 - footerRows)
    // 每格扣掉一列標題
    const perSection = Math.max(1, Math.floor(logRows / Math.max(1, sections.length)) - 1)
    const windows = sections.map(one =>
      scrollEntries((allLogs[one.key] ?? []).slice(-LOG_ENTRIES), perSection, rowsOf, textColumns, wantBack),
    )
    maxBack = Math.max(0, ...windows.map(one => one.maxBack))
    const back = Math.min(wantBack, maxBack)
    const setPinned = (key: string) => {
      void update($, view, current => ({ ...current, pinned: key }))
      void update($, scrollBack, () => 0)
    }
    // 一次翻半格；desktop 的滾輪不一定傳得到 mod，所以用按鈕翻
    const page = Math.max(1, Math.floor(perSection / 2))
    const scrollBy = (rows: number) => void update($, scrollBack, current => Math.min(maxBack, Math.max(0, current + rows)))

    const entryRow = (entry: Entry) => {
      const isWrapped = isProse(entry)

      // 時間與標籤固定寬度不縮；內容那欄要能縮窄，否則 desktop 會把它排成一長行再切掉
      return (
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0}>
            <Text dimColor>{entry.time}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={COLORS[entry.kind]} bold={entry.kind !== 'output'}>
              {LABELS[entry.kind]}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text
              color={entry.kind === 'error' ? 'red' : undefined}
              dimColor={entry.kind === 'output'}
              wrap={isWrapped ? 'wrap' : 'truncate-end'}
            >
              {isWrapped ? entry.text.slice(0, PROSE_CHARS) : entry.text.replace(/\s+/g, ' ')}
            </Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {/* 這個時間不動就是輪詢停了；時間有動但內容沒動才是 Codex 沒寫東西 */}
        <Text dimColor wrap="truncate-end">
          polled {lastPoll > 0 ? clockTime(lastPoll) : '—'}          {back > 0 ? ` · ↑ ${back} rows back, press ⤓ latest to follow` : ''}
        </Text>
        <Box flexDirection="column" flexShrink={0}>
          {sections.length === 0 && <Text dimColor>Waiting for the rollout…</Text>}
          {sections.map((one, index) => (
            <Box key={`section-${one.key}`} flexDirection="column" flexShrink={0}>
              <Text dimColor wrap="truncate-middle">
                ── {one.isRunning ? '●' : '○'} {one.title} · {one.cwd || one.status} ──
              </Text>
              {(windows[index]?.shown ?? []).map(entryRow)}
            </Box>
          ))}
        </Box>
        {rows.map((one, index) => (
          <Button
            key={`row-${one.key}`}
            plain
            hotkey={String(index + 1)}
            dimColor={!one.isRunning && one.key !== pinned}
            label={clipWidth(
              oneLine(`${one.key === pinned ? '📌' : ''}${one.isRunning ? '●' : '○'} [${one.source}] ${one.title} · ${one.lastLine || one.status}`, width),
              width,
            )}
            onPress={() => setPinned(one.key === pinned ? '' : one.key)}
          />
        ))}
        <Box flexDirection="row" gap={2} flexShrink={0}>
          <Button key="older" plain hotkey="k" label="↑ older" onPress={() => scrollBy(page)} />
          <Button key="newer" plain hotkey="j" label="↓ newer" onPress={() => scrollBy(-page)} />
          {back > 0 && <Button key="latest" plain hotkey="l" label="⤓ latest" onPress={() => scrollBy(-back)} />}
          {pinned && <Button key="unpin" plain hotkey="f" label="show all again" onPress={() => setPinned('')} />}
        </Box>
      </Box>
    )
  })

  // 畫面剛好是 pane 的高度，pane 本身不會捲；滾輪改成捲中間的 log 區
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await update($, scrollBack, back => Math.min(maxBack, Math.max(0, back - e.by)))

    return {}
  })
}
