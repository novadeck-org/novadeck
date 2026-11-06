import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import { eraseRows, leaveShell, type BoxProfile, type InputBox } from "./box/box.js"
import { unwrapped } from "./box/text.js"
import { Handovers, type HandoverNote } from "./handover.js"
import { InputQueue } from "./queue.js"
import { screen } from "./testing/screens.js"

type Options = {
  readonly text?: string
  readonly shell?: boolean
  readonly view?: boolean
  readonly noBox?: boolean
  readonly noErase?: boolean
  /** Whether the text changes between reads, as someone typing. */
  readonly typing?: boolean
  readonly viewport?: number
  readonly ringing?: boolean
  readonly ringLine?: boolean
  readonly known?: string
  readonly refused?: boolean
  readonly enteredAgo?: number
  readonly pasteLost?: boolean
  readonly noShell?: boolean
  readonly refusesFrom?: number
  readonly noKeys?: boolean
  /** How many rows a box this tall shows: only the text's last ones. */
  readonly tailOnly?: boolean
  readonly noExpand?: boolean
  /** Whether the keys take only the box's last row. */
  readonly partialErase?: boolean
  /** Whether no box reads once keys were written. */
  readonly goesAfterKeys?: boolean
  /** Whether the hold on the person's keys lapses as a `!` is typed. */
  readonly lapsesOnBang?: boolean
  /** How long after the start a delivery under way ends, in milliseconds. */
  readonly ringEnds?: number
  /** Whether the screen takes no bracketed paste. */
  readonly noPaste?: boolean
  /** Whether a paste is keys, as Codex's on Windows. */
  readonly pasteKeys?: boolean
}

const fake = (options: Options = {}) => {
  let text = options.text ?? ""
  let shell = options.shell ?? false
  let reads = 0
  let admits = 0
  let holds = true
  let ringsOn = options.ringEnds !== undefined
  if (options.ringEnds !== undefined) setTimeout(() => (ringsOn = false), options.ringEnds)
  const written: string[] = []
  const typed: string[] = []
  const notes: HandoverNote[] = []

  const draw = (): ScreenText => {
    reads += 1
    if (options.noBox || (options.goesAfterKeys && written.length > 0))
      return screen({ rows: ["a dialog", ""], columns: 40 })
    const shown = options.typing ? `${text}${reads}` : text
    const lines = options.tailOnly ? shown.split("\n").slice(-2) : shown.split("\n")
    const body = lines.map((line, at) => (at === 0 ? `${shell ? "!" : ">"} ${line}` : `  ${line}`))
    return screen({
      rows: ["header", ...body, "footer", ""],
      columns: 40,
      bracketedPaste: !options.noPaste,
      cursor: { row: lines.length, column: (lines.at(-1)?.length ?? 0) + 2 },
    })
  }

  const profile: BoxProfile = {
    read: (seen): InputBox | undefined => {
      if (seen.rows[0] !== "header") return undefined
      const last = seen.rows.indexOf("footer") - 1
      return {
        text: seen.rows
          .slice(1, last + 1)
          .map((row) => row.slice(2))
          .join("\n"),
        mode: seen.rows[1]!.startsWith("!") ? "shell" : "prompt",
        first: 1,
        last,
      }
    },
    collapsed: ({ text: shown }) => /^\[Pasted #\d+\]$/.test(shown.trim()),
    stands: (shown) => shown.includes("[Pasted #"),
    textWidth: (columns) => columns - 3,
    shell: {
      expands: !options.noExpand,
      starts: false,
      footer: () => false,
      ...(!options.noKeys && { leave: leaveShell }),
    },
    overlay: () => options.view === true,
    queued: () => false,
    collapses: () => false,
    room: () => 30,
    ...(!options.noKeys && { erase: eraseRows }),
    ...(options.pasteKeys && { pastesAsKeys: () => true }),
    ...(options.viewport !== undefined && { viewport: () => options.viewport! }),
  }

  const handovers = new Handovers(
    {
      admit: () => {
        admits += 1
        if (options.refusesFrom !== undefined && admits >= options.refusesFrom)
          throw new Error("A request came.")
        return profile
      },
      ringing: () => (options.ringing || ringsOn ? "nonce" : undefined),
      screen: () => Promise.resolve(draw()),
      type: (_id, data) => {
        typed.push(data)
        if (data === "!") {
          if (options.lapsesOnBang) holds = false
          if (!options.noShell) shell = true
          return true
        }
        if (data === "\x7f") {
          shell = false
          return true
        }
        const pasted = data.slice(6, -6).replaceAll("\r", "\n")
        if (!options.pasteLost) text += pasted
        return true
      },
      write: (_id, data) => {
        written.push(data)
        if (options.partialErase) text = text.split("\n")[0]!
        else if (!options.noErase) {
          text = ""
          if (data.endsWith("\x7f")) shell = false
        }
        return true
      },
      known: () => options.known,
      ringLine: () => options.ringLine ?? false,
      enteredAt: () =>
        options.enteredAgo === undefined ? undefined : Date.now() - options.enteredAgo,
      refuse: () => (options.refused ? "A picker would open." : undefined),
      note: (_id, note) => notes.push(note),
    },
    new InputQueue({
      hold: () => ({
        release: () => {},
        settle: () => {},
        settleAfter: () => {},
        holding: () => holds,
        discard: () => {},
      }),
    }),
    { pollMs: 1, steadyMs: 2, emptyMs: 30, keysMs: 40, pasteMs: 40, ringMs: 20 },
  )
  return {
    handovers,
    written,
    typed,
    notes,
    box: () => text,
    shell: () => shell,
  }
}

describe("unwrapped", () => {
  it("joins a row the next one's first word wouldn't have fit on", () => {
    expect(unwrapped("wrapping words\nthat go on", 18)).toBe("wrapping words that go on")
  })

  it("keeps a line break where that word would have fit", () => {
    expect(unwrapped("short\nnext line", 18)).toBe("short\nnext line")
  })

  it("joins a word broken at the box's width with no space, and keeps blank lines", () => {
    expect(unwrapped("xxxxxxxxxx\nxxx\n\nend", 10)).toBe("xxxxxxxxxxxxx\n\nend")
  })

  it("joins a row of words that fills the box with a space, as it ends a word", () => {
    expect(unwrapped("some words\nnext", 10)).toBe("some words next")
  })
})

describe("clearing what a box holds, as the person asked", () => {
  const any = () => true

  it("empties it of a command, its keys going once", async () => {
    const tui = fake({ text: "/model\nand more" })
    await expect(tui.handovers.clear("t", any)).resolves.toBe(true)
    expect(tui.written).toEqual(["\x15\x7f\x15"])
    expect(tui.box()).toBe("")
    expect(tui.notes).toEqual(["cleared"])
  })

  it("empties it of a placeholder", async () => {
    const tui = fake({ text: "[Pasted #1]" })
    await expect(tui.handovers.clear("t", any)).resolves.toBe(true)
    expect(tui.box()).toBe("")
  })

  it("leaves its shell mode with what it holds", async () => {
    const tui = fake({ text: "ls -la", shell: true })
    await expect(tui.handovers.clear("t", any)).resolves.toBe(true)
    expect(tui.written).toEqual(["\x15\x7f"])
    expect(tui.box()).toBe("")
  })

  it("goes for more than a tail shows, in one write", async () => {
    const tui = fake({ text: "one\ntwo\nthree", viewport: 2, tailOnly: true })
    await expect(tui.handovers.clear("t", any)).resolves.toBe(true)
    expect(tui.written).toEqual([`${"\x15\x7f".repeat(256)}\x15`])
  })

  it("writes nothing over what the person wasn't shown", async () => {
    const tui = fake({ text: "typed since" })
    const asked: string[] = []
    const seen = (text: string) => {
      asked.push(text)
      return false
    }
    await expect(tui.handovers.clear("t", seen)).resolves.toBe(false)
    expect(asked).toEqual(["typed since"])
    expect(tui.written).toEqual([])
    expect(tui.notes).toEqual(["changed"])
  })

  it("has nothing to do for an empty box", async () => {
    const tui = fake({ text: "" })
    await expect(tui.handovers.clear("t", any)).resolves.toBe(true)
    expect(tui.written).toEqual([])
  })

  it("writes nothing where something covers the box", async () => {
    const tui = fake({ text: "words", view: true })
    await expect(tui.handovers.clear("t", any)).resolves.toBe(false)
    expect(tui.written).toEqual([])
    expect(tui.notes).toEqual(["no-box"])
  })

  it("writes nothing where a delivery goes on, or for a harness with no keys", async () => {
    const ringing = fake({ text: "words", ringing: true })
    await expect(ringing.handovers.clear("t", any)).resolves.toBe(false)
    expect(ringing.written).toEqual([])
    expect(ringing.notes).toEqual(["ringing"])
    const keyless = fake({ text: "words", noKeys: true })
    await expect(keyless.handovers.clear("t", any)).resolves.toBe(false)
    expect(keyless.notes).toEqual(["unreadable"])
  })

  it("says so where the box doesn't read empty, and presses nothing again", async () => {
    const tui = fake({ text: "words", noErase: true })
    await expect(tui.handovers.clear("t", any)).resolves.toBe(false)
    expect(tui.written).toEqual(["\x15"])
    expect(tui.notes).toEqual(["clear-unconfirmed"])
  })
})

describe("taking what a box holds", () => {
  it("empties the box and gives its words, wrapped rows joined", async () => {
    const tui = fake({ text: `${"word ".repeat(7).trim()}\nthat wrapped\nand a line` })
    await expect(tui.handovers.take("t")).resolves.toBe(
      `${"word ".repeat(7).trim()} that wrapped\nand a line`,
    )
    expect(tui.written).toEqual(["\x15\x7f\x15\x7f\x15"])
    expect(tui.box()).toBe("")
    expect(tui.notes).toEqual(["taken"])
  })

  it("gives text Novadeck knows as it was given", async () => {
    const tui = fake({ text: "one\ntwo", known: "one two" })
    await expect(tui.handovers.take("t")).resolves.toBe("one two")
  })

  it("gives a shell mode's command with its !, the mode left", async () => {
    const tui = fake({ text: "ls -la", shell: true })
    await expect(tui.handovers.take("t")).resolves.toBe("!ls -la")
    expect(tui.written).toEqual(["\x15\x7f"])
    expect(tui.shell()).toBe(false)
  })

  it("waits out a delivery under way, as the box is taken from just once", async () => {
    const tui = fake({ text: "words", ringEnds: 8 })
    await expect(tui.handovers.take("t")).resolves.toBe("words")
  })

  it.each([
    ["nothing to take", {}, []],
    ["an empty shell mode", { shell: true }, []],
    ["no box", { noBox: true }, []],
    ["a view over it", { text: "words", view: true }, []],
    ["a ring's line", { text: "line", ringLine: true }, ["ring-line"]],
    ["a command of the program's, which the chat can't send", { text: "/he" }, ["command"]],
    ["a ring under way", { text: "words", ringing: true }, ["ringing"]],
    ["a text that may be only its tail", { text: "a\nb\nc", viewport: 3 }, ["unreadable"]],
    ["a placeholder", { text: "[Pasted #1]" }, ["unreadable"]],
    ["words beside a placeholder", { text: "words[Pasted #1]" }, ["unreadable"]],
    ["a box that keeps changing", { text: "words", typing: true }, ["unsteady"]],
    ["a program with no keys for it", { text: "words", noKeys: true }, ["unreadable"]],
  ] as const)("leaves %s alone", async (_name, options, notes) => {
    const tui = fake(options)
    await expect(tui.handovers.take("t")).resolves.toBeUndefined()
    expect(tui.written).toEqual([])
    expect(tui.notes).toEqual(notes)
  })

  it("presses the keys once, and gives nothing, where the box didn't read empty", async () => {
    const tui = fake({ text: "words", noErase: true })
    await expect(tui.handovers.take("t")).resolves.toBeUndefined()
    expect(tui.written).toEqual(["\x15"])
    expect(tui.notes).toEqual(["clear-unconfirmed"])
    expect(tui.box()).toBe("words")
  })

  it("gives only what the keys took, what's left there for the next take", async () => {
    const tui = fake({ text: "one\ntwo", partialErase: true })
    await expect(tui.handovers.take("t")).resolves.toBe("two")
    expect(tui.notes).toEqual(["clear-unconfirmed"])
    expect(tui.box()).toBe("one")
  })

  it("gives nothing where the box can't be read after the keys", async () => {
    const tui = fake({ text: "words", noErase: true, goesAfterKeys: true })
    await expect(tui.handovers.take("t")).resolves.toBeUndefined()
    expect(tui.notes).toEqual(["clear-unconfirmed"])
  })

  it("waits out the time the box may still show a prompt just sent", async () => {
    const tui = fake({ text: "just sent", enteredAgo: 0 })
    const began = Date.now()
    await tui.handovers.take("t")
    expect(Date.now() - began).toBeGreaterThanOrEqual(25)
  })

  it("presses nothing into a request that came meanwhile", async () => {
    const tui = fake({ text: "words", refusesFrom: 2 })
    await expect(tui.handovers.take("t")).rejects.toThrow("A request came.")
    expect(tui.written).toEqual([])
  })
})

describe("putting a draft in the box", () => {
  it("pastes it with no Enter, and says so", async () => {
    const tui = fake()
    await expect(tui.handovers.put("t", "  a draft\n")).resolves.toBe(true)
    expect(tui.typed).toEqual(["\x1b[200~a draft\x1b[201~"])
    expect(tui.typed).not.toContain("\r")
    expect(tui.notes).toEqual(["placed"])
  })

  it("types a shell command's ! as a key, into its shell mode", async () => {
    const tui = fake()
    await expect(tui.handovers.put("t", "!ls -la")).resolves.toBe(true)
    expect(tui.typed).toEqual(["!", "\x1b[200~ls -la\x1b[201~"])
    expect(tui.shell()).toBe(true)
  })

  it.each([
    ["the box holds text", { text: "words" }, ["not-empty"]],
    ["the box is in its shell mode", { shell: true }, ["not-empty"]],
    ["there's no box", { noBox: true }, ["not-empty"]],
    ["a view covers it", { view: true }, ["not-empty"]],
    ["the text would open a picker", { refused: true }, ["shape"]],
    ["a ring is under way", { ringing: true }, ["ringing"]],
    ["the screen takes no bracketed paste", { noPaste: true }, ["no-paste"]],
  ] as const)("keeps it where %s", async (_name, options, notes) => {
    const tui = fake(options)
    await expect(tui.handovers.put("t", "a draft")).resolves.toBe(false)
    expect(tui.typed).toEqual([])
    expect(tui.notes).toEqual(notes)
  })

  it("takes a tail of it for its having shown, in a box that shows no more", async () => {
    const tui = fake({ viewport: 2, tailOnly: true })
    await expect(tui.handovers.put("t", "one\ntwo\nthree")).resolves.toBe(true)
  })

  it("keeps lines whose first break would be an Enter, where a paste is keys", async () => {
    const short = fake({ pasteKeys: true })
    await expect(short.handovers.put("t", "short\nthe second")).resolves.toBe(false)
    expect(short.typed).toEqual([])
    expect(short.notes).toEqual(["shape"])
    const long = fake({ pasteKeys: true })
    await expect(long.handovers.put("t", "a first line long enough\nthe second")).resolves.toBe(
      true,
    )
    const one = fake({ pasteKeys: true })
    await expect(one.handovers.put("t", "one line")).resolves.toBe(true)
  })

  it("keeps a long command where its shell mode would run the placeholder", async () => {
    const tui = fake({ noExpand: true })
    await expect(tui.handovers.put("t", `!${"x".repeat(300)}`)).resolves.toBe(false)
    expect(tui.typed).toEqual([])
    expect(tui.notes).toEqual(["shape"])
  })

  it("takes a typed ! back out where a request came after it", async () => {
    const tui = fake({ refusesFrom: 3 })
    await expect(tui.handovers.put("t", "!ls")).rejects.toThrow("A request came.")
    expect(tui.typed).toEqual(["!", "\x7f"])
    expect(tui.shell()).toBe(false)
  })

  it("types no ! into a request that came while the box was read", async () => {
    const tui = fake({ refusesFrom: 2 })
    await expect(tui.handovers.put("t", "!ls")).rejects.toThrow("A request came.")
    expect(tui.typed).toEqual([])
  })

  it("types the ! back out where the wait for it ended, so no line runs as a command", async () => {
    const tui = fake({ lapsesOnBang: true })
    await expect(tui.handovers.put("t", "!ls")).resolves.toBe(false)
    expect(tui.typed).toEqual(["!", "\x7f"])
    expect(tui.shell()).toBe(false)
  })

  it("keeps it where it never showed, or a ! didn't switch the box", async () => {
    const lost = fake({ pasteLost: true })
    await expect(lost.handovers.put("t", "a draft")).resolves.toBe(false)
    expect(lost.notes).toEqual(["not-shown"])
    const stays = fake({ noShell: true })
    await expect(stays.handovers.put("t", "!ls")).resolves.toBe(false)
    expect(stays.typed).toEqual(["!"])
    expect(stays.notes).toEqual(["shell-unconfirmed"])
  })
})
