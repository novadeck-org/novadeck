import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { followLines, maxLine, tailLines } from "./follow.js"

type Told = { line: string; end: number }

let directory: string
let path: string
let controllers: AbortController[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "novadeck-follow-"))
  path = join(directory, "transcript.jsonl")
  controllers = []
})

// Every reading stops, whether its test passed or not, so none polls on into the next.
afterEach(() => {
  for (const controller of controllers) controller.abort()
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Follows `path` as a reader does, keeping each line and where it ends; `idle` resolves
 * once it has read all there is, the next time after each call, with whether the file was
 * there. `onLine` may stand in for the default to make one line's call throw.
 */
const follow = (options: Omit<Parameters<typeof followLines>[3] & {}, "onIdle"> = {}) => {
  const controller = new AbortController()
  controllers.push(controller)
  const told: Told[] = []
  const resets: number[] = []
  let waiting: ((found: boolean) => void)[] = []
  void followLines(path, controller.signal, (line, end) => told.push({ line, end }), {
    intervalMs: 20,
    onReset: () => resets.push(told.length),
    ...options,
    onIdle: (found) => {
      const resolve = waiting
      waiting = []
      for (const each of resolve) each(found)
    },
  })
  const idle = () => new Promise<boolean>((resolve) => waiting.push(resolve))
  const lines = () => told.map(({ line }) => line)
  return { told, resets, idle, lines, stop: () => controller.abort() }
}

describe("following a file's lines", () => {
  it("reads only what is written after it starts, whole lines at a time", async () => {
    writeFileSync(path, "old\n")
    const reader = follow()
    await reader.idle()
    appendFileSync(path, "new\npart")
    await expect.poll(reader.lines).toEqual(["new"])
    appendFileSync(path, "ial\n")
    await expect.poll(reader.lines).toEqual(["new", "partial"])
  })

  it("reads a file that appears later from its start, telling idle it wasn't there till then", async () => {
    const reader = follow()
    expect(await reader.idle()).toBe(false)
    writeFileSync(path, "first\nsecond\n")
    await expect.poll(reader.lines).toEqual(["first", "second"])
    expect(await reader.idle()).toBe(true)
  })

  it("reads a rewritten file again from its start, telling its reset", async () => {
    writeFileSync(path, "a long line before the rewrite\n")
    const reader = follow()
    await reader.idle()
    writeFileSync(path, "short\n")
    await expect.poll(reader.lines).toEqual(["short"])
    expect(reader.resets).toEqual([0])
  })

  it("reads a file rewritten in place, longer than what it read, again from its start", async () => {
    writeFileSync(path, '{"turn":1}\n')
    const reader = follow({ fromStart: true })
    await expect.poll(reader.lines).toEqual(['{"turn":1}'])
    await reader.idle()
    // Over the same bytes, never shorter, so only its content says it was rewritten.
    const handle = openSync(path, "r+")
    writeSync(handle, '{"compacted":true}\n{"turn":2}\n', 0)
    closeSync(handle)
    await expect.poll(reader.lines).toEqual(['{"turn":1}', '{"compacted":true}', '{"turn":2}'])
    expect(reader.resets).toEqual([1])
    expect(reader.told.at(-1)?.end).toBe(30)
  })

  it("keeps a character whole when a write splits it", async () => {
    writeFileSync(path, "")
    const reader = follow()
    await reader.idle()
    const bytes = Buffer.from("żółw\n")
    appendFileSync(path, bytes.subarray(0, 1))
    await reader.idle()
    appendFileSync(path, bytes.subarray(1))
    await expect.poll(reader.lines).toEqual(["żółw"])
  })

  it("says where each line ends in the file, in bytes, across writes, blank lines and a rewrite", async () => {
    writeFileSync(path, "old\n")
    const reader = follow({ fromStart: true })
    await expect.poll(() => reader.told).toEqual([{ line: "old", end: 4 }])
    appendFileSync(path, "żółw\n\nab")
    await reader.idle()
    appendFileSync(path, "c\n")
    await expect.poll(() => reader.told.length).toBe(3)
    // "żółw" is 7 bytes; the blank line counts though it is never told.
    expect(reader.told.slice(1)).toEqual([
      { line: "żółw", end: 12 },
      { line: "abc", end: 17 },
    ])
    writeFileSync(path, "new\n")
    await expect.poll(() => reader.told.at(-1)).toEqual({ line: "new", end: 4 })
  })

  it("counts a byte that isn't UTF-8 as the one byte it is", async () => {
    writeFileSync(
      path,
      Buffer.concat([Buffer.from("a"), Buffer.from([0xff]), Buffer.from("b\nc\n")]),
    )
    const reader = follow({ fromStart: true })
    await expect.poll(() => reader.told.length).toBe(2)
    expect(reader.told.map(({ end }) => end)).toEqual([4, 6])
  })

  it("waits for a slow reader before reading more", async () => {
    writeFileSync(path, "a\n")
    let reads = 0
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    let asked: () => void = () => {}
    const waiting = new Promise<void>((resolve) => (asked = resolve))
    const reader = follow({
      fromStart: true,
      pace: () => {
        reads += 1
        if (reads === 1) return Promise.resolve()
        asked()
        return held
      },
    })
    await expect.poll(reader.lines).toEqual(["a"])
    // The next read waits on the reader, so a line written now stays unread until it lets go.
    await waiting
    appendFileSync(path, "b\n")
    expect(reader.lines()).toEqual(["a"])
    release?.()
    await expect.poll(reader.lines).toEqual(["a", "b"])
  })

  it("loses only the call that threw: the lines after it arrive, ending where they do", async () => {
    let thrown = false
    const told: Told[] = []
    writeFileSync(path, "first\nboom\nlost1\nlost2\n")
    const controller = new AbortController()
    controllers.push(controller)
    let idled = 0
    void followLines(
      path,
      controller.signal,
      (line, end) => {
        if (line === "boom" && !thrown) {
          thrown = true
          throw new Error("the reader failed")
        }
        told.push({ line, end })
      },
      {
        intervalMs: 20,
        fromStart: true,
        onIdle: () => {
          idled += 1
          if (idled === 1) throw new Error("so did its idle")
        },
      },
    )
    await expect.poll(() => told.map(({ line }) => line)).toEqual(["first", "lost1", "lost2"])
    // It reads on after an idle that threw.
    await expect.poll(() => idled).toBeGreaterThan(1)
    appendFileSync(path, "after\n")
    await expect.poll(() => told.at(-1)).toEqual({ line: "after", end: 29 })
    expect(told.map(({ end }) => end)).toEqual([6, 17, 23, 29])
  })
})

describe("following a file's long lines", () => {
  // A line of `length` bytes, JSON as a record is, with what it is at the start.
  const record = (length: number) => {
    const head = `{"type":"response_item","output":"`
    return `${head}${"a".repeat(length - head.length - 2)}"}`
  }
  const lengths = (told: readonly Told[]) => told.map(({ line }) => line.length)

  // Where the line starts against the reads' 1 MiB chunks: at a chunk, just before one,
  // and partway into one.
  for (const lead of [0, 1024 * 1024 - 3, 512 * 1024 + 7])
    it(`passes on a line over 5 MiB whole, starting ${lead} bytes in`, async () => {
      const big = record(6 * 1024 * 1024 + 11)
      const first = "x".repeat(Math.max(0, lead - 1))
      writeFileSync(path, `${lead === 0 ? "" : `${first}\n`}${big}\n{"type":"next"}\n`)
      const reader = follow({ fromStart: true })
      await expect.poll(() => reader.told.length, { timeout: 10_000 }).toBe(lead === 0 ? 2 : 3)
      expect(lengths(reader.told)).toEqual([...(lead === 0 ? [] : [lead - 1]), big.length, 15])
      expect(reader.told.at(-1)).toEqual({ line: '{"type":"next"}', end: lead + big.length + 17 })
    })

  it("passes on a line over 5 MiB whole as it is written, a piece at a time", async () => {
    writeFileSync(path, "")
    const reader = follow()
    await reader.idle()
    const big = record(5 * 1024 * 1024 + 500 * 1024)
    const cuts = [0, 2_000_000, 4_500_000, big.length]
    for (const [index, at] of cuts.slice(0, -1).entries()) {
      appendFileSync(path, big.slice(at, cuts[index + 1]))
      // eslint-disable-next-line no-await-in-loop -- Each piece is read before the next is written.
      await reader.idle()
    }
    appendFileSync(path, '\n{"type":"next"}\n')
    await expect.poll(() => reader.told.length, { timeout: 10_000 }).toBe(2)
    expect(lengths(reader.told)).toEqual([big.length, 15])
  })

  it("passes on a line of exactly its limit", async () => {
    writeFileSync(path, `${record(maxLine)}\nnext\n`)
    const reader = follow({ fromStart: true })
    await expect.poll(() => reader.told.length, { timeout: 20_000 }).toBe(2)
    expect(lengths(reader.told)).toEqual([maxLine, 4])
  })

  // Over its limit, whatever the alignment, with nothing of it told, not even its tail.
  for (const lead of [0, 1024 * 1024 - 5])
    it(`skips a line over its limit whole, starting ${lead} bytes in`, async () => {
      const big = record(maxLine + 1)
      const first = "y".repeat(Math.max(0, lead - 1))
      writeFileSync(path, `${lead === 0 ? "" : `${first}\n`}${big}\n{"type":"next"}\n`)
      const reader = follow({ fromStart: true })
      await expect.poll(reader.lines, { timeout: 20_000 }).toContain('{"type":"next"}')
      expect(lengths(reader.told)).toEqual([...(lead === 0 ? [] : [lead - 1]), 15])
      expect(reader.told.at(-1)?.end).toBe(lead + big.length + 17)
    })
})

describe("a file's last lines", () => {
  it("are its last bytes' lines, the first cut short", async () => {
    writeFileSync(path, "one\ntwo\nthree\n")
    expect(await tailLines(path, 9)).toEqual(["wo", "three", ""])
    expect(await tailLines(path)).toEqual(["one", "two", "three", ""])
  })

  it("are undefined where the file can't be read", async () => {
    expect(await tailLines(join(directory, "missing"))).toBeUndefined()
  })
})
