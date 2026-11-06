import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import { eraseRows, leaveShell, type BoxProfile, type InputBox } from "./box/box.js"
import { PromptRefusal, Prompts, WordsTaken, type BoxNote, type PromptMode } from "./prompts.js"
import { InputQueue } from "./queue.js"
import { screen } from "./testing/screens.js"

// A program's box as a prompt finds it holding something: a text and a cursor in it, keys and
// pastes acting on them as the probes found the harnesses' do (a paste lands at the cursor), so
// what ends up on the box and what is sent can be read back.

type Options = {
  readonly text?: string
  /** Where the cursor stands in the text; its end where left out. */
  readonly cursor?: number
  readonly shell?: boolean
  readonly view?: boolean
  readonly noBox?: boolean
  /** Whether End and Down don't move the cursor, as after an update changed them. */
  readonly stuck?: boolean
  /** Whether Ctrl-U doesn't take, as after an update changed it. */
  readonly noErase?: boolean
  /** Whether Ctrl-U takes only the last row and then stops, as a partial erase. */
  readonly partialErase?: boolean
  /** Whether Backspace doesn't leave the shell mode. */
  readonly staysInShell?: boolean
  /** Whether the paste shows only as a placeholder after the text. */
  readonly placeholder?: boolean
  /** Whether a paste goes nowhere. */
  readonly pasteLost?: boolean
  /** The keys of the profile; none where false. */
  readonly keys?: boolean
  readonly viewport?: number
  /** Whether the box says it shows only part of its text. */
  readonly cut?: boolean
  /** What a paste shows as, where that isn't what was pasted. */
  readonly landsAs?: string
  /** How many rows a cut box shows of its text, the rest under a row that counts them. */
  readonly window?: number
  /** Whether a cut box is scrolled to its start, the rest under a row below. */
  readonly scrolled?: boolean
  /** Whether a paste is keys, as Codex's on Windows, a line break in one an Enter at its start. */
  readonly pasteKeys?: boolean
  /** Refuses from this `admit` on, as a request that came. */
  readonly refusesFrom?: number
  readonly known?: string
  readonly ringLine?: boolean
}

const fake = (options: Options = {}) => {
  let text = options.text ?? ""
  let cursor = options.cursor ?? text.length
  let shell = options.shell ?? false
  const written: string[] = []
  const typed: string[] = []
  const sent: string[] = []
  const notes: BoxNote[] = []
  let admits = 0
  let joins = 0

  const lines = (): string[] => {
    const whole = text.split("\n")
    const { window } = options
    const cut = window !== undefined && whole.length > window
    const shown =
      cut && options.scrolled
        ? [...whole.slice(0, window), `↓ ${whole.length - window} more lines`]
        : cut
          ? [`↑ ${whole.length - window} more lines`, ...whole.slice(-window)]
          : whole
    return shown.map((line, at) => (at === 0 ? `${shell ? "!" : ">"} ${line}` : `  ${line}`))
  }

  const draw = (): ScreenText => {
    if (options.noBox) return screen({ rows: ["a dialog", ""], columns: 40 })
    const body = lines()
    const before = text.slice(0, cursor).split("\n")
    const row =
      options.window === undefined || options.scrolled ? before.length - 1 : body.length - 1
    const rows = ["header", ...body, "footer", ""]
    return screen({
      rows,
      columns: 40,
      cursor: { row: row + 1, column: (before.at(-1)?.length ?? 0) + 2 },
    })
  }

  const profile: BoxProfile = {
    read: (seen): InputBox | undefined => {
      if (seen.rows[0] !== "header") return undefined
      const last = seen.rows.indexOf("footer") - 1
      const shown = seen.rows
        .slice(1, last + 1)
        .map((row) => row.slice(2))
        .join("\n")
      return {
        text: shown,
        mode: seen.rows[1]!.startsWith("!") ? "shell" : "prompt",
        first: 1,
        last,
      }
    },
    stands: (shown) => shown.includes("[Pasted #"),
    textWidth: (columns) => columns - 3,
    collapsed: ({ text: shown }) => /^\[Pasted #\d+\]$/.test(shown.trim()),
    shell: {
      expands: true,
      starts: false,
      footer: () => false,
      ...(options.keys !== false && { leave: leaveShell }),
    },
    overlay: () => options.view === true,
    queued: () => false,
    collapses: () => false,
    room: () => 30,
    ...(options.keys !== false && { erase: eraseRows }),
    ...(options.pasteKeys && { pastesAsKeys: () => true }),
    ...(options.cut === true && {
      cut: ({ text: shown }: InputBox) => /^↑ |\n↓ \d+ more lines?$/.test(shown),
      uncut: (shown: string) => shown.replace(/^↑ \d+ more lines?\n/, ""),
    }),
    ...(options.viewport !== undefined && { viewport: () => options.viewport! }),
  }

  /** What keys do to the box. */
  const press = (keys: string): void => {
    let rest = keys
    while (rest !== "") {
      if (rest.startsWith("\x1b[B")) {
        rest = rest.slice(3)
        if (options.stuck) continue
        const after = text.indexOf("\n", cursor)
        if (after >= 0) cursor = after + 1
      } else if (rest.startsWith("\x1b[F")) {
        rest = rest.slice(3)
        if (options.stuck) continue
        const after = text.indexOf("\n", cursor)
        cursor = after < 0 ? text.length : after
      } else if (rest.startsWith("\x15")) {
        rest = rest.slice(1)
        if (options.noErase) continue
        const start = text.lastIndexOf("\n", cursor - 1) + 1
        text = text.slice(0, start) + text.slice(cursor)
        cursor = start
        if (options.partialErase) rest = ""
      } else if (rest.startsWith("\x7f")) {
        rest = rest.slice(1)
        if (text === "" && shell && !options.staysInShell) shell = false
        else if (cursor > 0) {
          text = text.slice(0, cursor - 1) + text.slice(cursor)
          cursor -= 1
        }
      } else rest = rest.slice(1)
    }
  }

  const prompts = new Prompts(
    {
      admit: () => {
        admits += 1
        if (options.refusesFrom !== undefined && admits >= options.refusesFrom)
          throw new Error("A request came.")
        return profile
      },
      bound: () => true,
      ringing: () => undefined,
      screen: () => Promise.resolve(draw()),
      type: (_id, data) => {
        typed.push(data)
        if (data === "\r") {
          sent.push(text)
          text = ""
          cursor = 0
          return true
        }
        if (data === "!") {
          shell = true
          return true
        }
        // eslint-disable-next-line no-control-regex -- A paste's brackets are what it reads.
        const pasted = /^\x1b\[200~(.*)\x1b\[201~$/s.exec(data)?.[1]?.replaceAll("\r", "\n")
        // Keys: what the paste starts with is pressed, Enter and all, as it was on Windows.
        if (options.pasteKeys && pasted?.startsWith("\n")) {
          sent.push(text)
          text = pasted.trimStart()
          cursor = text.length
          return true
        }
        if (pasted !== undefined && !options.pasteLost) {
          const shown = options.placeholder ? "[Pasted #1]" : (options.landsAs ?? pasted)
          text = text.slice(0, cursor) + shown + text.slice(cursor)
          cursor += shown.length
        }
        return true
      },
      write: (_id, data) => {
        written.push(data)
        press(data)
        return true
      },
      known: () => options.known,
      ringLine: () => options.ringLine ?? false,
      note: (_id, note) => notes.push(note),
    },
    new InputQueue({
      hold: () => ({
        release: () => {},
        settle: () => {},
        settleAfter: () => {},
        holding: () => true,
        discard: () => {},
      }),
    }),
    { pollMs: 1, emptyMs: 10, pasteMs: 150, keysMs: 60, settleMs: 0, bindMs: 0 },
  )
  const give = (
    words: string,
    mode: PromptMode = "freed",
    joined: () => void = () => void (joins += 1),
  ) => prompts.prompt("t", words, mode, joined)
  return {
    give,
    written,
    typed,
    sent,
    notes,
    box: () => text,
    shell: () => shell,
    joins: () => joins,
    pasted: () => typed.filter((data) => data.startsWith("\x1b[200~")),
  }
}

const refused = async (work: Promise<unknown>, reason: string): Promise<void> => {
  const failure = await work.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(PromptRefusal)
  expect((failure as PromptRefusal).reason).toBe(reason)
}

describe("a prompt over text in the box", () => {
  it("goes along with it, a blank line between, and says so", async () => {
    const tui = fake({ text: "half typed" })
    await expect(tui.give("the message")).resolves.toEqual({ returned: undefined })
    expect(tui.sent).toEqual(["half typed\n\nthe message"])
    expect(tui.written).toEqual([])
    expect(tui.notes).toEqual(["sent-along"])
  })

  it("is refused when it may not, writing nothing", async () => {
    const tui = fake({ text: "half typed" })
    await refused(tui.give("the message", "alone"), "draft")
    expect(tui.typed).toEqual([])
    expect(tui.box()).toBe("half typed")
  })

  it("puts the cursor after the text first, however far up it was", async () => {
    const tui = fake({ text: "one\ntwo\nthree", cursor: 1 })
    await tui.give("the message")
    expect(tui.written).toEqual(["\x1b[B\x1b[B\x1b[F"])
    expect(tui.sent).toEqual(["one\ntwo\nthree\n\nthe message"])
  })

  it("is refused with nothing pasted where the cursor can't be seen to get there", async () => {
    const tui = fake({ text: "half typed", cursor: 2, stuck: true })
    await refused(tui.give("the message"), "draft")
    expect(tui.written).toEqual(["\x1b[F"])
    expect(tui.pasted()).toEqual([])
    expect(tui.notes).toEqual(["cursor-unconfirmed"])
    expect(tui.box()).toBe("half typed")
  })

  it("goes along with a box that may show only a tail, though the words it shows are known", async () => {
    const tui = fake({ text: "one\ntwo\nthree", viewport: 3, known: "one\ntwo\nthree" })
    await tui.give("the message")
    // Nothing erased: it would take rows it can't see.
    expect(tui.written).toEqual([])
    expect(tui.notes).not.toContain("cleared")
    expect(tui.pasted()).toHaveLength(1)
  })

  describe("over a box that says it is cut", () => {
    const queue = Array.from({ length: 6 }, (_, at) => `line ${at + 1}`).join("\n")
    const over = (extra: Options = {}) => fake({ text: queue, cut: true, window: 3, ...extra })

    it("goes along, its row counting more lines and the rest moved on", async () => {
      const tui = over()
      await tui.give("the message")
      expect(tui.written).toEqual([])
      expect(tui.sent).toEqual([`${queue}\n\nthe message`])
    })

    it("goes along though the message is taller than what the box shows", async () => {
      const tall = Array.from({ length: 9 }, (_, at) => `para ${at + 1}`).join("\n")
      const tui = over()
      await tui.give(tall)
      expect(tui.sent).toEqual([`${queue}\n\n${tall}`])
    })

    it("is refused where the paste doesn't show, however the words repeat", async () => {
      const same = "again\nagain\nagain\nagain\nagain\nagain"
      for (const text of [queue, same]) {
        const tui = over({ text, pasteLost: true })
        // eslint-disable-next-line no-await-in-loop -- One after another.
        await refused(tui.give("again"), "not-shown")
        expect(tui.sent).toEqual([])
      }
    })

    it("is refused where the box moved on but doesn't show the message", async () => {
      const tui = over({ landsAs: "\n\nsomething else" })
      await refused(tui.give("the message"), "not-shown")
      expect(tui.sent).toEqual([])
    })

    it("goes along as a placeholder, where the paste shows as one", async () => {
      const tui = over({ landsAs: "\n\n[Pasted #1]" })
      await tui.give("x".repeat(2_000))
      expect(tui.sent).toHaveLength(1)
    })

    it("is refused where a placeholder doesn't follow what the box held", async () => {
      const tui = over({ landsAs: "\n\nsomething else\n\n[Pasted #1]" })
      await refused(tui.give("x".repeat(2_000)), "not-shown")
      expect(tui.sent).toEqual([])
    })

    it("pastes nothing where it is scrolled up, its cursor away from the end", async () => {
      const tui = over({ scrolled: true, cursor: 1 })
      await refused(tui.give("the message"), "draft")
      expect(tui.written).toEqual([])
      expect(tui.pasted()).toEqual([])
    })
  })

  it("doesn't move a cursor in a box that may show only a tail", async () => {
    const tui = fake({ text: "one\ntwo\nthree", cursor: 1, viewport: 3 })
    await refused(tui.give("the message"), "draft")
    expect(tui.written).toEqual([])
    expect(tui.pasted()).toEqual([])
  })

  it("is refused over a command of the program's, and with no box to type into", async () => {
    for (const [options, reason] of [
      [{ text: "/help" }, "command"],
      [{ text: "!ls" }, "command"],
      [{ text: "words", view: true }, "no-box"],
      [{ noBox: true }, "no-box"],
      [{ text: "1. Yes\n2. No" }, "no-box"],
    ] as const) {
      const tui = fake(options)
      // eslint-disable-next-line no-await-in-loop -- One after another.
      await refused(tui.give("the message"), reason)
      expect(tui.typed).toEqual([])
      expect(tui.written).toEqual([])
    }
  })

  it("leaves a line a delivery left to it", async () => {
    const tui = fake({ text: "the doorbell's line", ringLine: true })
    await refused(tui.give("the message"), "ringing")
    expect(tui.typed).toEqual([])
    expect(tui.notes).toEqual(["ringing"])
  })

  it("presses no Enter where it never showed after the text, and says so", async () => {
    const tui = fake({ text: "half typed", pasteLost: true })
    await refused(tui.give("the message"), "not-shown")
    expect(tui.sent).toEqual([])
    expect(tui.typed).not.toContain("\r")
    expect(tui.notes).toEqual(["not-shown"])
  })

  it("takes a placeholder of what it pasted, right after the text", async () => {
    const tui = fake({ text: "half typed", placeholder: true })
    await tui.give("one\ntwo\nthree\nfour")
    expect(tui.sent).toEqual(["half typed[Pasted #1]"])
  })

  it("goes along with a box that may show only a tail", async () => {
    const tui = fake({ text: "one\ntwo\nthree", viewport: 3 })
    await tui.give("the message")
    expect(tui.sent).toEqual(["one\ntwo\nthree\n\nthe message"])
  })

  it("presses no key into a request that came meanwhile", async () => {
    const tui = fake({ text: "half typed", cursor: 2, refusesFrom: 3 })
    await expect(tui.give("the message")).rejects.toThrow("A request came.")
    expect(tui.written).toEqual([])
    expect(tui.typed).toEqual([])
  })
})

describe("a prompt over text where a paste is keys", () => {
  it("presses no Enter with the paste: a space sets it apart, and its record is told", async () => {
    const tui = fake({ text: "half typed", pasteKeys: true })
    await tui.give("the message")
    expect(tui.pasted()).toEqual(["\x1b[200~ the message\x1b[201~"])
    expect(tui.sent).toEqual(["half typed the message"])
    expect(tui.joins()).toBe(1)
  })

  it("tells the prompt being typed, not the one queued behind it", async () => {
    const tui = fake({ text: "half typed", pasteKeys: true })
    const told: string[] = []
    await Promise.all([
      tui.give("the first", "freed", () => told.push("first")),
      tui.give("the second", "freed", () => told.push("second")),
    ])
    expect(told).toEqual(["first"])
  })

  it("goes with a long first line, whose line breaks come in a burst of typing", async () => {
    const tui = fake({ text: "half typed", pasteKeys: true })
    await tui.give("a first line long enough\nthe second")
    expect(tui.sent).toEqual(["half typed a first line long enough\nthe second"])
  })

  it("is refused with a short first line, whose line break would be an Enter", async () => {
    const tui = fake({ text: "half typed", pasteKeys: true })
    await refused(tui.give("short\nthe second"), "draft")
    expect(tui.pasted()).toEqual([])
    expect(tui.notes).toEqual(["draft-kept"])
  })

  it("leaves a blank line where a paste is text", async () => {
    const tui = fake({ text: "half typed" })
    await tui.give("the message")
    expect(tui.pasted()).toEqual(["\x1b[200~\r\rthe message\x1b[201~"])
    expect(tui.joins()).toBe(0)
  })
})

describe("a prompt over text Novadeck knows", () => {
  it("takes it out and hands its words back, sending alone", async () => {
    const tui = fake({ text: "came back", known: "came back" })
    await expect(tui.give("the message")).resolves.toEqual({ returned: "came back" })
    expect(tui.written).toEqual(["\x15"])
    expect(tui.sent).toEqual(["the message"])
    expect(tui.notes).toEqual(["cleared"])
  })

  it("erases each row, after moving the cursor to the last", async () => {
    const tui = fake({ text: "one\ntwo", cursor: 1, known: "one\ntwo" })
    await tui.give("the message")
    expect(tui.written).toEqual(["\x1b[B\x1b[F", "\x15\x7f\x15"])
    expect(tui.sent).toEqual(["the message"])
  })

  it("presses the key once, and goes along where the box didn't read empty", async () => {
    const tui = fake({ text: "came back", known: "came back", noErase: true })
    await expect(tui.give("the message")).resolves.toEqual({
      returned: undefined,
      along: "came back",
    })
    expect(tui.written).toEqual(["\x15"])
    expect(tui.notes).toEqual(["clear-unconfirmed", "sent-along"])
    expect(tui.sent).toEqual(["came back\n\nthe message"])
  })

  it("goes on over nothing a clear left half done, the words going back all the same", async () => {
    const tui = fake({ text: "one\ntwo", known: "one\ntwo", partialErase: true })
    const failure = await tui.give("the message").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WordsTaken)
    expect((failure as WordsTaken).returned).toBe("two")
    expect(((failure as WordsTaken).failure as PromptRefusal).reason).toBe("draft")
    expect(tui.notes).toEqual(["clear-unconfirmed", "draft-kept"])
    expect(tui.pasted()).toEqual([])
  })

  it("sends it along where it may hand nothing back", async () => {
    const tui = fake({ text: "came back", known: "came back" })
    await tui.give("the message", "along")
    expect(tui.written).toEqual([])
    expect(tui.sent).toEqual(["came back\n\nthe message"])
  })

  it("sends along where a program has no keys to erase with", async () => {
    const tui = fake({ text: "came back", known: "came back", keys: false })
    await tui.give("the message")
    expect(tui.sent).toEqual(["came back\n\nthe message"])
  })
})

describe("a prompt that fails after it took words out", () => {
  const failure = async (work: Promise<unknown>): Promise<WordsTaken> => {
    const caught = await work.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(WordsTaken)
    return caught as WordsTaken
  }

  it("gives what it took with the failure, where the paste never showed", async () => {
    const tui = fake({ text: "came back", known: "came back", pasteLost: true })
    const { failure: why, returned } = await failure(tui.give("the message"))
    expect(returned).toBe("came back")
    expect((why as PromptRefusal).reason).toBe("not-shown")
    expect(tui.typed).not.toContain("\r")
  })

  it("gives a shell mode's command with a request that came after it", async () => {
    const tui = fake({ shell: true, text: "ls -la", refusesFrom: 4 })
    const { failure: why, returned } = await failure(tui.give("the message"))
    expect(returned).toBe("!ls -la")
    expect((why as Error).message).toBe("A request came.")
  })
})

describe("a shell command over text", () => {
  it("is refused, as it can't go along", async () => {
    const tui = fake({ text: "half typed" })
    await refused(tui.give("!ls"), "draft")
    expect(tui.typed).toEqual([])
    expect(tui.notes).toEqual(["draft-kept"])
  })

  it("goes once what Novadeck knows is out of the box", async () => {
    const tui = fake({ text: "came back", known: "came back" })
    await expect(tui.give("!ls")).resolves.toEqual({ returned: "came back" })
    expect(tui.typed[0]).toBe("!")
    expect(tui.sent).toEqual(["ls"])
  })
})

describe("a prompt over a shell mode", () => {
  it("leaves an empty one and goes alone", async () => {
    const tui = fake({ shell: true })
    await expect(tui.give("the message")).resolves.toEqual({ returned: undefined })
    expect(tui.written).toEqual(["\x7f"])
    expect(tui.shell()).toBe(false)
    expect(tui.sent).toEqual(["the message"])
    expect(tui.notes).toEqual(["left-shell"])
  })

  it("takes a command out with it, handing it back with its !", async () => {
    const tui = fake({ shell: true, text: "ls -la" })
    await expect(tui.give("the message")).resolves.toEqual({ returned: "!ls -la" })
    expect(tui.written).toEqual(["\x15\x7f"])
    expect(tui.sent).toEqual(["the message"])
  })

  it("stays where it can't hand the command back, or may only leave it", async () => {
    for (const [options, mode] of [
      [{ shell: true, text: "[Pasted #1]" }, "freed"],
      [{ shell: true, text: "git commit -m [Pasted #1]" }, "freed"],
      [{ shell: true, text: "one\ntwo\nthree", viewport: 3 }, "freed"],
      [{ shell: true, text: "ls -la" }, "along"],
      [{ shell: true, keys: false }, "freed"],
    ] as const) {
      const tui = fake(options)
      // eslint-disable-next-line no-await-in-loop -- One after another.
      await refused(tui.give("the message", mode), "shell-mode")
      expect(tui.written).toEqual([])
      expect(tui.notes).toEqual(["shell-kept"])
    }
  })

  it("is refused, pressing the key once, where it doesn't leave", async () => {
    const tui = fake({ shell: true, staysInShell: true })
    await refused(tui.give("the message"), "shell-mode")
    expect(tui.written).toEqual(["\x7f"])
    expect(tui.notes).toEqual(["shell-unconfirmed"])
    expect(tui.pasted()).toEqual([])
  })

  it("gives back a command the keys took part of, though the mode stayed", async () => {
    const tui = fake({ shell: true, text: "one\ntwo", partialErase: true })
    const failure = await tui.give("the message").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WordsTaken)
    expect((failure as WordsTaken).returned).toBe("!two")
  })

  it("hands a wrapped command back on one line", async () => {
    const wrapped = `${"word ".repeat(7).trim()}\nthat wrapped`
    const tui = fake({ shell: true, text: wrapped })
    await expect(tui.give("the message")).resolves.toEqual({
      returned: `!${wrapped.replace("\n", " ")}`,
    })
  })

  it("is refused as ever where it may only find the box empty", async () => {
    const tui = fake({ shell: true })
    await refused(tui.give("the message", "alone"), "shell-mode")
    expect(tui.written).toEqual([])
  })
})
