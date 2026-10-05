import { expect, test } from 'claude-code/testing'

import { countCodexExecs, isCodexExec, isExecRollout, jobsOfSession, matchExecs, rolloutName, threadOfBridgeSend } from './sources'

const THREAD = '019f177a-a7a3-7231-a6a3-7ba654b3b845'

test('only the jobs this Claude session started are tracked', () => {
  const state = JSON.stringify({
    jobs: [
      { id: 'task-a', sessionId: 'mine', kindLabel: 'rescue', status: 'running', phase: 'turn', threadId: THREAD, createdAt: '2026-10-05T01:00:00Z' },
      { id: 'task-b', sessionId: 'other', status: 'running' },
    ],
  })
  const jobs = jobsOfSession(state, 'mine')
  expect(jobs.map(job => job.key)).toEqual(['plugin:task-a'])
  expect(jobs[0]).toMatchObject({ threadId: THREAD, isRunning: true, status: 'running · turn' })
  expect(jobsOfSession('not json', 'mine')).toEqual([])
})

test('codex exec is recognised in its usual spellings and nothing else', () => {
  for (const command of [
    'codex exec "fix it"',
    'cd repo && codex e --json "x"',
    '& "C:\\tools\\codex.exe" exec -m gpt "x"',
    'npx -y @openai/codex exec "x"',
  ]) {
    expect(isCodexExec(command)).toBe(true)
  }
  for (const command of [
    'codex resume',
    'codex review',
    'echo codexexec',
    'mycodex exec',
    'echo "- never pass --sandbox to codex exec here" >> MEMORY.md',
    "git commit -m 'run codex exec later'",
  ]) {
    expect(isCodexExec(command)).toBe(false)
  }
})

test('a rollout file name gives its local start time and thread', () => {
  const named = rolloutName(`rollout-2026-06-30T15-42-27-${THREAD}.jsonl`)
  expect(named?.threadId).toBe(THREAD)
  expect(named?.startedAt).toBe(new Date(2026, 5, 30, 15, 42, 27).getTime())
  expect(rolloutName('notes.jsonl')).toBeUndefined()
})

test('an exec rollout is told apart by its session_meta', () => {
  expect(isExecRollout('{"type":"session_meta","payload":{"originator":"codex_exec","source":"exec"}}')).toBe(true)
  expect(isExecRollout('{"type":"session_meta","payload":{"originator":"codex-tui","source":"cli"}}')).toBe(false)
})

test('a bridge send yields its thread from the input or the result', () => {
  expect(threadOfBridgeSend({ threadId: THREAD }, undefined)).toBe(THREAD)
  expect(threadOfBridgeSend({ text: 'hi' }, { content: [{ type: 'text', text: `{"threadId":"${THREAD}"}` }] })).toBe(THREAD)
  expect(threadOfBridgeSend({ text: 'hi' }, { content: [] })).toBe('')
})

test('every codex exec in one command is counted', () => {
  expect(countCodexExecs('codex exec "review A" & codex exec "review B"')).toBe(2)
  expect(countCodexExecs('Start-Job { codex exec "a" }; Start-Job { codex e "b" }')).toBe(2)
  expect(countCodexExecs('echo "codex exec" && codex exec "real"')).toBe(1)
})

test('two execs launched together get the rollout whose prompt they carry, whatever the file order', () => {
  const t0 = 1_000_000
  const waiting = [
    { key: 'a', startedAt: t0, command: 'codex exec "Review turnRegistry.mjs only"' },
    { key: 'b', startedAt: t0, command: 'codex exec "Explain threadQueue.mjs briefly"' },
  ]
  const files = [
    { threadId: 'T-explain', startedAt: t0 + 1000, prompt: 'Explain threadQueue.mjs briefly', ageMs: 2000 },
    { threadId: 'T-review', startedAt: t0 + 1000, prompt: 'Review turnRegistry.mjs only', ageMs: 2000 },
  ]
  expect(Object.fromEntries(matchExecs(waiting, files))).toEqual({ a: 'T-review', b: 'T-explain' })
})

test('a rollout whose prompt is not in any command falls back to time order after a grace period', () => {
  const waiting = [{ key: 'stdin', startedAt: 0, command: 'Get-Content p.md | codex exec -' }]
  const file = { threadId: 'T', startedAt: 1000, prompt: 'from a file', ageMs: 3000 }
  expect(matchExecs(waiting, [file]).size).toBe(0)
  const old = [{ ...file, ageMs: 9000 }]
  expect(Object.fromEntries(matchExecs(waiting, old))).toEqual({ stdin: 'T' })
})

test('a rollout started well before the exec is never matched to it', () => {
  const waiting = [{ key: 'a', startedAt: 100_000, command: 'codex exec "hi"' }]
  expect(matchExecs(waiting, [{ threadId: 'T', startedAt: 10_000, prompt: 'hi', ageMs: 99_000 }]).size).toBe(0)
})
