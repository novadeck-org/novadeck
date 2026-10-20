import { createScreen, transcript, type Screen } from "@novadeck/emulator/headless"

import { describe, expect, it } from "../test.js"
import { redactTranscript } from "./transcriptRedaction.js"

const written = (screen: Screen, data: string): Promise<void> =>
  new Promise((resolve) => screen.write(data, resolve))

const COLS = 80
const ROWS = 6
const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"

// A screen with `output` drawn on it, and the transcript of it, as saving takes one.
const saved = async (output: string, cols = COLS, rows = ROWS, maxChars = 256 * 1024) => {
  const screen = createScreen({ cols, rows, scrollback: 1000 })
  await written(screen, output)
  const text = transcript(screen, maxChars)
  if (text === null) throw new Error("blank")
  return { screen, text, lines: screen.buffer.normal.length }
}

const redacted = async (output: string, cols = COLS, rows = ROWS, maxChars = 256 * 1024) => {
  const { text, lines } = await saved(output, cols, rows, maxChars)
  return { text, result: await redactTranscript({ text, cols, rows, lines, maxChars }) }
}

// The lines of a screen the transcript is drawn on again: text, and each cell's colour.
const drawn = async (text: string, cols = COLS, rows = ROWS) => {
  const screen = createScreen({ cols, rows, scrollback: 1000 })
  await written(screen, text)
  const buffer = screen.buffer.normal
  const cell = buffer.getNullCell()
  return Array.from({ length: buffer.length }, (_, y) => {
    const line = buffer.getLine(y)
    const colours: number[] = []
    for (let x = 0; x < cols; x += 1) colours.push(line?.getCell(x, cell)?.getFgColor() ?? -1)
    return { text: line?.translateToString(true) ?? "", colours }
  })
}
const textOf = async (text: string, cols = COLS, rows = ROWS) =>
  (await drawn(text, cols, rows)).map((line) => line.text)

describe("masking the secrets in a transcript", () => {
  it("hands text with no secret back as it is", async () => {
    const { text, result } = await redacted(
      "$ ls\r\n\x1b[1;34msrc\x1b[0m  README.md\r\n\x1b[38;2;1;2;3mcolour\x1b[0m\r\n你好 world\r\n$ ",
    )

    expect(result).toBe(text)
  })

  it("masks a token in plain output, a column for each of its characters", async () => {
    const { result } = await redacted(`$ echo ${token}\r\n${token}\r\n$ `)

    const rows = await textOf(result ?? "")
    expect(result).not.toContain("abcdefghij")
    expect(rows.filter(Boolean)).toEqual([
      `$ echo ${"*".repeat(token.length)}`,
      "*".repeat(token.length),
      "$ ",
    ])
  })

  it("masks a token in coloured output and keeps its colour", async () => {
    const { result } = await redacted(`key: \x1b[31m${token}\x1b[0m done\r\n$ `)

    const [row] = await drawn(result ?? "")
    expect(result).not.toContain("abcdefghij")
    expect(row?.text).toBe(`key: ${"*".repeat(token.length)} done`)
    // 31 is the palette's red: the stars have the cell's own colour.
    expect(row?.colours[6]).toBe(1)
    expect(row?.colours[0]).not.toBe(1)
  })

  it("masks a token the terminal wrapped, on both rows", async () => {
    // At 40 columns the token and its prefix wrap onto a second row.
    const { result } = await redacted(`echo ${token}\r\n$ `, 40)

    const rows = await textOf(result ?? "", 40)
    expect(rows.join("")).not.toMatch(/ghp_|abcdef|0123456789/)
    expect(rows[0]).toBe(`echo ${"*".repeat(35)}`)
    expect(rows[1]).toBe("*".repeat(token.length - 35))
    expect(rows[2]).toBe("$ ")
  })

  it("masks a token a program broke by hand at the edge of the row", async () => {
    // Two full rows with a line break between them: no soft wrap, but a secret may go on.
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09"
    const { result } = await redacted(`${hex.slice(0, 40)}\r\n${hex.slice(40)}\r\n$ `, 40)

    const rows = await textOf(result ?? "", 40)
    expect(rows.join("")).not.toMatch(/9f86d0|15b0f00a/)
    expect(rows[0]).toBe("*".repeat(40))
    expect(rows[1]).toBe("*".repeat(24))
  })

  it("masks a key block over all the rows it covers", async () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"
    const { result } = await redacted(
      `$ cat key\r\n-----BEGIN PRIVATE KEY-----\r\n${body}\r\n${body}\r\n-----END PRIVATE KEY-----\r\n$ ls`,
    )

    const rows = await textOf(result ?? "")
    expect(rows.join("")).not.toMatch(/MIIEvQ|BEGIN|END PRIVATE/)
    expect(rows[0]).toBe("$ cat key")
    expect(rows.at(-1)).toBe("$ ls")
    expect(rows.some((row) => row.startsWith("****"))).toBe(true)
  })

  it("masks a secret after wide characters and emoji on the same row", async () => {
    const { result } = await redacted(`你好 😀 👨‍👩‍👧 password=hunter2abc ok\r\n$ `)

    const rows = await textOf(result ?? "")
    expect(rows[0]).toBe(`你好 😀 👨‍👩‍👧 password=${"*".repeat(10)} ok`)
  })

  it("masks a secret beside wide characters, a double-width mask for each wide one", async () => {
    const { result } = await redacted(`token=你好hunter2你 end\r\n$ `)

    const [row] = await drawn(result ?? "")
    // A double-width character is masked with the one double-width `＊`.
    expect(row?.text).toBe(`token=＊＊${"*".repeat(7)}＊ end`)
  })

  it("keeps the cursor where it was and the lines it had", async () => {
    const before = await saved(`$ echo ${token}\r\nline\r\n\x1b[1;3H`)
    const result = await redactTranscript({
      text: before.text,
      cols: COLS,
      rows: ROWS,
      lines: before.lines,
      maxChars: 256 * 1024,
    })

    const after = createScreen({ cols: COLS, rows: ROWS, scrollback: 1000 })
    await written(after, result ?? "")
    expect(after.buffer.normal.length).toBe(before.lines)
    expect([after.buffer.normal.cursorX, after.buffer.normal.cursorY]).toEqual([
      before.screen.buffer.normal.cursorX,
      before.screen.buffer.normal.cursorY,
    ])
  })

  it("keeps the rest of a long transcript as drawn, scrollback and all", async () => {
    const output = `${Array.from({ length: 50 }, (_, i) => `line ${i} \x1b[32mok\x1b[0m`).join("\r\n")}\r\nTOKEN=${token}\r\n$ `
    const { text, result } = await redacted(output)

    const before = await drawn(text)
    const after = await drawn(result ?? "")
    expect(after).toHaveLength(before.length)
    expect(after.map((line) => line.text).filter((row) => !row.includes("*"))).toEqual(
      before.map((line) => line.text).filter((row) => !row.includes(token.slice(0, 10))),
    )
    expect(after.some((line) => line.text.includes("TOKEN="))).toBe(true)
    expect(result).not.toContain("abcdef")
  })

  it("keeps within the character limit, dropping the oldest scrollback", async () => {
    const output = `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\r\n")}\r\nTOKEN=${token}\r\n$ `
    const maxChars = 1200
    const { text, result } = await redacted(output, COLS, ROWS, maxChars)

    expect(text.length).toBeLessThanOrEqual(maxChars)
    expect(result?.length).toBeLessThanOrEqual(maxChars)
    const rows = await textOf(result ?? "")
    expect(rows.join("\n")).toContain("line 299")
    expect(rows.join("\n")).not.toContain("line 0\n")
    expect(rows.join("\n")).not.toContain("abcdef")
  })

  it("is empty, nothing to keep, when not even the visible rows fit", async () => {
    const { text, lines } = await saved(`TOKEN=${token}\r\n$ `)

    expect(await redactTranscript({ text, cols: COLS, rows: ROWS, lines, maxChars: 5 })).toBe("")
    const plain = await saved("one\r\ntwo")
    expect(
      await redactTranscript({
        text: plain.text,
        cols: COLS,
        rows: ROWS,
        lines: plain.lines,
        maxChars: 3,
      }),
    ).toBe("")
  })

  it.each([true, false])(
    "fits the limit on a wide, coloured screen with 1000 lines of scrollback (secret: %s)",
    async (secret) => {
      const output = Array.from(
        { length: 1100 },
        (_, i) =>
          `\x1b[3${i % 8}m你好 line ${i} 😀 ${secret && i % 97 === 0 ? `TOKEN=${token}` : "plain"}\x1b[0m`,
      ).join("\r\n")
      const screen = createScreen({ cols: COLS, rows: ROWS, scrollback: 1000 })
      await written(screen, output)
      const text = transcript(screen, Number.POSITIVE_INFINITY) ?? ""
      const lines = screen.buffer.normal.length
      expect(lines).toBeGreaterThan(1000)

      for (const maxChars of [text.length, Math.floor(text.length / 2), 5000]) {
        // eslint-disable-next-line no-await-in-loop -- Each limit is tried on its own.
        const result = await redactTranscript({ text, cols: COLS, rows: ROWS, lines, maxChars })
        expect(result.length).toBeLessThanOrEqual(maxChars)
        expect(result.length).toBeGreaterThan(0)
        expect(result).not.toContain("abcdef")
        // The newest lines are the ones kept.
        // eslint-disable-next-line no-await-in-loop -- As above.
        expect((await textOf(result, COLS, ROWS)).join("\n")).toContain("line 1099")
      }
    },
  )

  it("masks a value after a double-width character that did not fit at the end of the row", async () => {
    // At 20 columns the wide character leaves the last column of its row empty.
    const { result } = await redacted("password=abcdefghij你hunter2xyzSECRETtail\r\n$ ", 20, 10)

    const rows = await textOf(result ?? "", 20, 10)
    expect(rows.join("")).not.toMatch(/abcdef|hunter2|SECRET|tail/)
  })

  describe("on a screen with more lines than rows", () => {
    const tall = async (extra: string, rows = 6) => {
      const output = `${Array.from({ length: 40 }, (_, i) => `line ${i} 你好`).join("\r\n")}\r\nTOKEN=${token} ${extra}\r\n`
      const screen = createScreen({ cols: COLS, rows, scrollback: 1000 })
      await written(screen, output)
      return { screen, text: transcript(screen, Number.POSITIVE_INFINITY) ?? "" }
    }

    it("keeps the text's line count, cursor and ending, even with no room to spare", async () => {
      const { screen, text } = await tall("你好")
      const lines = screen.buffer.normal.length

      const result = await redactTranscript({
        text,
        cols: COLS,
        rows: 6,
        lines,
        maxChars: text.length,
      })

      expect(text.endsWith("\r\n")).toBe(true)
      expect(result?.endsWith("\r\n")).toBe(true)
      expect(result?.length).toBeLessThanOrEqual(text.length)
      const after = createScreen({ cols: COLS, rows: 6, scrollback: 1000 })
      await written(after, result ?? "")
      expect(after.buffer.normal.length).toBe(lines)
      expect([after.buffer.normal.cursorX, after.buffer.normal.cursorY]).toEqual([
        screen.buffer.normal.cursorX,
        screen.buffer.normal.cursorY,
      ])
      expect(result).not.toContain("abcdef")
      // The oldest lines are all there: nothing was cut.
      expect((await textOf(result ?? "", COLS, 6))[0]).toBe("line 0 你好")
    })

    it("cuts text larger than the limit as transcript does, to the newest lines", async () => {
      const { screen, text } = await tall("")
      const maxChars = Math.floor(text.length / 2)

      const result = await redactTranscript({
        text,
        cols: COLS,
        rows: 6,
        lines: screen.buffer.normal.length,
        maxChars,
      })

      expect(result?.length).toBeLessThanOrEqual(maxChars)
      expect(result).not.toContain("abcdef")
      const rows = await textOf(result ?? "", COLS, 6)
      expect(rows.join("\n")).toContain("TOKEN=*")
      expect(rows[0]).not.toBe("line 0 你好")
    })

    it("cuts text with no secret in it that is larger than the limit", async () => {
      const screen = createScreen({ cols: COLS, rows: 6, scrollback: 1000 })
      await written(screen, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\r\n"))
      const text = transcript(screen, Number.POSITIVE_INFINITY) ?? ""

      const result = await redactTranscript({
        text,
        cols: COLS,
        rows: 6,
        lines: screen.buffer.normal.length,
        maxChars: 200,
      })

      expect(result).toBe(transcript(screen, 200))
    })
  })

  it("masks a name and value the cut would have split, whatever the limit", async () => {
    // The name ends one row and the value starts the next, at the row the first cut keeps.
    const value = "hunter2SECRETvalue99"
    const build = (at: number): string =>
      Array.from({ length: 80 }, (_, i) =>
        i === at ? `${"y".repeat(31)} API_KEY=${value}` : `line ${i}`,
      ).join("\r\n")
    const probe = createScreen({ cols: 40, rows: 6, scrollback: 1000 })
    await written(probe, build(0))
    // The first cut keeps half of the scrollback: it starts at the row after this one.
    const at = Math.ceil(probe.buffer.normal.baseY / 2) - 1
    const screen = createScreen({ cols: 40, rows: 6, scrollback: 1000 })
    await written(screen, build(at))
    const text = transcript(screen, Number.POSITIVE_INFINITY) ?? ""
    const lines = screen.buffer.normal.length

    let straddled = 0
    for (let maxChars = 300; maxChars <= text.length; maxChars += 37) {
      const cut = transcript(screen, maxChars) ?? ""
      if (cut.includes(value.slice(0, 8)) && !cut.includes("API_KEY")) straddled += 1
      // eslint-disable-next-line no-await-in-loop -- Each limit is tried on its own.
      const result = await redactTranscript({ text, cols: 40, rows: 6, lines, maxChars })
      expect(result ?? "").not.toContain(value.slice(0, 8))
      expect(result ?? "").not.toContain("SECRETvalue")
    }
    // The limits tried did cut where a cut first would have left the value alone.
    expect(straddled).toBeGreaterThan(0)
  })

  it("keeps a cursor at the edge of the row, about to wrap, and does not grow", async () => {
    // The last row is full and masked, and the cursor waits at its end.
    const cols = 40
    const output = `x\r\n${"Ab1+".repeat(10)}`
    const screen = createScreen({ cols, rows: 5, scrollback: 1000 })
    await written(screen, output)
    expect(screen.buffer.normal.cursorX).toBe(cols)
    const text = transcript(screen, Number.POSITIVE_INFINITY) ?? ""

    const result = await redactTranscript({
      text,
      cols,
      rows: 5,
      lines: screen.buffer.normal.length,
      maxChars: Number.POSITIVE_INFINITY,
    })

    expect(result).toContain("*")
    expect(result.length).toBeLessThanOrEqual(text.length)
    const after = createScreen({ cols, rows: 5, scrollback: 1000 })
    await written(after, result)
    expect(after.buffer.normal.cursorX).toBe(cols)
  })

  describe("the time it takes", () => {
    it.each(["eyJ", "sk-", "-hf_"])(
      "is well under the deadline for 1000 lines of scrollback of %s on 500 columns",
      { timeout: 60_000 },
      async (unit) => {
        const cols = 500
        const rows = 100
        const screen = createScreen({ cols, rows, scrollback: 1000 })
        await written(screen, unit.repeat(Math.floor((cols * (1000 + rows)) / unit.length)))
        const text = transcript(screen, Number.POSITIVE_INFINITY) ?? ""
        const started = process.cpuUsage()

        const result = await redactTranscript({
          text,
          cols,
          rows,
          lines: screen.buffer.normal.length,
          maxChars: 256 * 1024,
        })

        const { user, system } = process.cpuUsage(started)
        expect(result.length).toBeLessThanOrEqual(256 * 1024)
        // 1.3 s here, 5.4 s when each row went over the same run again; the deadline is 6 s.
        expect((user + system) / 1000).toBeLessThan(4000)
      },
    )
  })
})
