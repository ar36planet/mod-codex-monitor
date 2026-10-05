import { expect, test } from 'claude-code/testing'

import { START, takeLines } from './reader'

const bytes = (text: string) => new TextEncoder().encode(text)

test('only whole lines are taken and a half-written line waits for the next read', () => {
  const first = takeLines(bytes('{"a":1}\n{"b":2}\n{"c"'), START, 1024)
  expect(first.text).toBe('{"a":1}\n{"b":2}\n')
  expect(first.cursor).toEqual({ offset: 16, isSkipping: false })

  const second = takeLines(bytes('{"c":3}\n'), first.cursor, 1024)
  expect(second.text).toBe('{"c":3}\n')
  expect(second.cursor.offset).toBe(24)
})

test('offsets count UTF-8 bytes so Chinese text is not cut', () => {
  const taken = takeLines(bytes('{"t":"中文"}\n'), START, 1024)
  expect(taken.text).toBe('{"t":"中文"}\n')
  expect(taken.cursor.offset).toBe(15)
})

test('a line longer than one batch is skipped up to its newline', () => {
  const huge = takeLines(bytes('x'.repeat(8)), START, 8)
  expect(huge).toEqual({ text: '', cursor: { offset: 8, isSkipping: true } })

  const rest = takeLines(bytes('xxx\n{"a":1}\n'), huge.cursor, 8)
  expect(rest.text).toBe('{"a":1}\n')
  expect(rest.cursor).toEqual({ offset: 20, isSkipping: false })
})
