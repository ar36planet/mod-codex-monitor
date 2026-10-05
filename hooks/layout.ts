import type { Entry } from '../types'

// 中日韓文字與全形符號佔兩格
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += WIDE.test(char) || char.length > 1 ? 2 : 1

  return width
}

// 截成一行放得下 columns 格
export function clipWidth(text: string, columns: number): string {
  if (displayWidth(text) <= columns) return text
  let used = 0
  let out = ''
  for (const char of text) {
    const width = displayWidth(char)
    if (used + width > columns - 1) break
    out += char
    used += width
  }

  return out + '…'
}

// 一段文字在 columns 寬的欄位裡換行後佔幾列
export function wrappedRows(text: string, columns: number): number {
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0)
}

// 截到換行後不超過 rows 列
function clipToRows(text: string, rows: number, columns: number): string {
  let used = 0
  let lineWidth = 0
  let end = 0
  for (const char of text) {
    const width = char === '\n' ? 0 : displayWidth(char)
    if (char === '\n' || lineWidth + width > columns) {
      used += 1
      lineWidth = 0
    }
    if (used >= rows) return text.slice(0, Math.max(0, end - 1)) + '…'
    lineWidth += width
    end += char.length
  }

  return text
}

// 往回捲 back 列後看得到的那一段；maxBack 是最多能往回捲幾列
export function scrollEntries(
  entries: readonly Entry[],
  rows: number,
  rowsOf: (entry: Entry) => number,
  columns: number,
  back: number,
): { shown: Entry[]; maxBack: number } {
  const total = entries.reduce((sum, entry) => sum + rowsOf(entry), 0)
  let end = entries.length
  let skipped = 0
  // 捲到一筆的中間就整筆跳過，很長的回覆也翻得過去
  while (end > 1 && skipped < back) {
    const last = entries[end - 1]
    if (!last) break
    skipped += rowsOf(last)
    end -= 1
  }

  return { shown: fitEntries(entries.slice(0, end), rows, rowsOf, columns), maxBack: Math.max(0, total - rows) }
}

// 從最後一筆往前挑，挑到換行後的總列數放得下 rows 為止；一筆都放不下時截短最後一筆
export function fitEntries(entries: readonly Entry[], rows: number, rowsOf: (entry: Entry) => number, columns: number): Entry[] {
  const shown: Entry[] = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!entry) continue
    const need = rowsOf(entry)
    if (used + need <= rows) {
      shown.unshift(entry)
      used += need
      continue
    }
    if (shown.length === 0 && rows > 0) shown.unshift({ ...entry, text: clipToRows(entry.text, rows, columns) })
    break
  }

  return shown
}
