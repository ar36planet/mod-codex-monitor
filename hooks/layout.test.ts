import { expect, test } from 'claude-code/testing'

import type { Entry } from '../types'
import { clipWidth, displayWidth, fitEntries, scrollEntries, wrappedRows } from './layout'

const entry = (text: string): Entry => ({ kind: 'codex', text, time: '12:00:00' })

test('Chinese characters take two columns', () => {
  expect(displayWidth('ab中文')).toBe(6)
  expect(wrappedRows('中文中文中文', 4)).toBe(3)
  expect(wrappedRows('ab\ncd', 10)).toBe(2)
  expect(clipWidth('中文中文', 5)).toBe('中文…')
})

test('only the newest entries that fit the rows left are shown', () => {
  const entries = [entry('old'), entry('a'.repeat(25)), entry('new')]
  const rowsOf = (one: Entry) => wrappedRows(one.text, 10)
  expect(fitEntries(entries, 4, rowsOf, 10).map(one => one.text)).toEqual(['a'.repeat(25), 'new'])
  expect(fitEntries(entries, 2, rowsOf, 10).map(one => one.text)).toEqual(['new'])
})

test('scrolling back shows older entries and stops at the first one', () => {
  const entries = ['1', '2', '3', '4', '5'].map(entry)
  const oneRow = () => 1
  expect(scrollEntries(entries, 2, oneRow, 10, 0)).toEqual({ shown: [entry('4'), entry('5')], maxBack: 3 })
  expect(scrollEntries(entries, 2, oneRow, 10, 2).shown.map(one => one.text)).toEqual(['2', '3'])
  expect(scrollEntries(entries, 2, oneRow, 10, 99).shown.map(one => one.text)).toEqual(['1'])
})

test('scrolling back into a long entry skips the whole entry', () => {
  const entries = [entry('short'), entry('a'.repeat(100))]
  const shown = scrollEntries(entries, 3, one => wrappedRows(one.text, 10), 10, 1).shown
  expect(shown.map(one => one.text)).toEqual(['short'])
})

test('a single entry taller than the room is cut to fit', () => {
  const [shown] = fitEntries([entry('a'.repeat(50))], 2, one => wrappedRows(one.text, 10), 10)
  expect(wrappedRows(shown?.text ?? '', 10)).toBeLessThanOrEqual(2)
  expect(shown?.text.endsWith('…')).toBe(true)
})
