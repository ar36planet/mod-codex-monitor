// rollout 的讀取進度：offset 是下一個要讀的 byte；isSkipping 表示正在略過一行比一批還長的行
export type Cursor = { offset: number; isSkipping: boolean }

export const START: Cursor = { offset: 0, isSkipping: false }

const NEWLINE = 10
const decoder = new TextDecoder('utf-8')

// 從 cursor.offset 起讀到的一批 bytes 裡取出完整的行；最後沒換行的半行留到下一批。
// 整批都沒有換行表示那一行比一批還長，就略過到下一個換行為止。
export function takeLines(chunk: Uint8Array, cursor: Cursor, batchBytes: number): { text: string; cursor: Cursor } {
  let start = 0
  if (cursor.isSkipping) {
    const end = chunk.indexOf(NEWLINE)
    if (end < 0) return { text: '', cursor: { offset: cursor.offset + chunk.length, isSkipping: true } }
    start = end + 1
  }

  const last = chunk.lastIndexOf(NEWLINE)
  if (last < start) {
    if (start === 0 && chunk.length >= batchBytes) {
      return { text: '', cursor: { offset: cursor.offset + chunk.length, isSkipping: true } }
    }
    return { text: '', cursor: { offset: cursor.offset + start, isSkipping: false } }
  }

  return {
    text: decoder.decode(chunk.subarray(start, last + 1)),
    cursor: { offset: cursor.offset + last + 1, isSkipping: false },
  }
}
