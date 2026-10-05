import { expect, test } from 'claude-code/testing'

import { parseRollout } from './parse'

const item = (timestamp: string, value: object) => ({ timestamp, type: 'event_msg', payload: { type: 'item_completed', item: value } })

const rows = [
  { timestamp: '2026-10-02T03:10:48Z', type: 'session_meta', payload: { cwd: 'C:\\Work\\ASAC' } },
  { timestamp: '2026-10-02T03:10:49Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
  item('2026-10-02T03:10:50Z', { type: 'UserMessage', content: [{ type: 'text', text: 'rebase it' }] }),
  // response_item 的 JS 包裝與 JSON 輸出不該出現
  { timestamp: '2026-10-02T03:10:51Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"git status"})' } },
  { timestamp: '2026-10-02T03:10:51Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'Script completed Wall time 2.8 seconds {"i":0}' } },
  { timestamp: '2026-10-02T03:10:51Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  item('2026-10-02T03:10:52Z', {
    type: 'CommandExecution',
    command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', 'git status'],
    parsed_cmd: [{ type: 'unknown', cmd: 'git status' }],
    exit_code: 0,
  }),
  item('2026-10-02T03:10:52Z', {
    type: 'CommandExecution',
    command: ['pwsh.exe', '-Command', 'git push'],
    exit_code: 1,
    stderr: '\nfatal: no upstream\nmore',
  }),
  item('2026-10-02T03:10:53Z', { type: 'AgentMessage', content: [{ type: 'Text', text: 'Done.' }] }),
]

const jsonl = (list: object[]) => list.map(row => JSON.stringify(row)).join('\n')

test('commands show as the real command with a result mark, with no wrapper noise', () => {
  const parsed = parseRollout(jsonl(rows) + '\n{"trunc')
  expect(parsed.cwd).toBe('C:\\Work\\ASAC')
  expect(parsed.isRunning).toBe(true)
  expect(parsed.entries.map(entry => [entry.kind, entry.text])).toEqual([
    ['turn', '── turn started ──'],
    ['user', 'rebase it'],
    ['tool', '✓  git status'],
    ['tool', '✗ exit 1  git push'],
    ['output', 'fatal: no upstream'],
    ['codex', 'Done.'],
  ])
})

test('a completed turn with an error ends running and reports the error', () => {
  const done = {
    timestamp: '2026-10-02T03:11:00Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 't1', duration_ms: 64000, error: { message: 'out of credits' } },
  }
  const parsed = parseRollout(jsonl([...rows, done]))
  expect(parsed.isRunning).toBe(false)
  expect(parsed.lastCompleted).toEqual({ turnId: 't1', text: 'out of credits', isError: true })
  expect(parsed.entries.at(-1)?.text).toBe('── turn complete (64s) ──')
})

test('an older rollout without item events still shows replies and tool names', () => {
  const old = [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] } },
    { type: 'response_item', payload: { type: 'function_call', namespace: 'clock', name: 'sleep', arguments: '{}' } },
  ]
  expect(parseRollout(jsonl(old)).entries.map(entry => entry.text)).toEqual(['Hi', 'clock.sleep'])
})
