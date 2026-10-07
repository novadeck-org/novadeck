import { setTimeout as sleep } from "node:timers/promises"

import { promptRefusal as refusedBy } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { BoxProfile, InputBox } from "../harnesses/box.js"
import { describe, expect, it } from "../test.js"
import { screen as screenOf } from "../testing/screens.js"
import { InputQueue, type HoldBudget, type InputHold } from "./input-queue.js"
import { Prompts, type PromptHost } from "./prompts.js"
import type { ScreenText } from "./screen.js"

/**
 * An adapter for the fake terminal's box: its first row led by `> ` (or `!` in its shell
 * mode), the rest indented, the lowest such row the box, and `[Pasted text #1 +4 lines]`
 * for a collapsed paste.
 */
const profileOf = (expands: boolean): BoxProfile => ({
  read: (screen: ScreenText): InputBox | undefined => {
    const first = screen.rows.findLastIndex((row) => row.startsWith("> ") || row.startsWith("!"))
    if (first < 0) return undefined
    let last = first
    while (screen.rows[last + 1]?.startsWith("  ")) last += 1
    const lines = screen.rows.slice(first, last + 1).map((row) => row.slice(2))
    const mode = screen.rows[first]!.startsWith("!") ? "shell" : "prompt"
    return { text: lines.join("\n").trimEnd(), mode, first, last }
  },
  collapsed: ({ text }) => /^\[Pasted text #\d+ \+\d+ lines\]$/.test(text),
  shell: { expands, footer: () => false },
  queued: () => false,
  collapses: (text) => text.length > 500,
  room: (rows) => rows - 3,
})

/**
 * A terminal as prompts see it: a box whose lines a paste changes as `takes` says, a
 * screen around it, and what messaging says of it.
 */
const terminal = (
  options: {
    /** What the TUI makes of a paste: its text in the box, a placeholder, or nothing. */
    takes?: "box" | "placeholder" | "nothing"
    /** Whether a far row changes with every look, as a spinner does. */
    spinner?: boolean
    bracketedPaste?: boolean
    /** Whether the agent has exited after the paste, leaving a shell's prompt with the text. */
    exits?: boolean
    /** Whether its screen shows no box at all. */
    noBox?: boolean
    /** How long the box goes on showing a message after its Enter, as a TUI clears it, in ms. */
    clearMs?: number
    /** What the box holds already, as the person's draft. */
    draft?: string
    /** What the screen shows above the box: earlier turns, or anything else. */
    history?: string[]
    /** A draft the box takes on its own as the paste comes, which the screen did not show. */
    lateDraft?: string
    /** A reason `admit` refuses. */
    refuses?: DomainError
    /** Admits the looks before the paste and refuses the one after it, as a request that comes meanwhile. */
    refusesLater?: DomainError
    /** How many looks it admits before it refuses. */
    laterFrom?: number
    /** Whether a typed `!` switches the box to its shell mode, which then shows `! ` and the paste. */
    shell?: boolean
    /** How long after it is typed a `!` takes to switch the box, in milliseconds. */
    bangMs?: number
    /** What the box holds at first, in its shell mode, as a `!` left from before. */
    drafted?: string
    /** Whether a paste puts the box in its shell mode, as a `!` left at its start would. */
    shellsPaste?: boolean
    /** Whether its shell mode runs a command shown as a placeholder as the command. */
    expands?: boolean
    /** The nonce of a ring under way, which `ringEnds` ms from the first look ends. */
    ringing?: string
    ringEnds?: number
    /** How long a hold lasts before it lapses by itself, in milliseconds. */
    holdMs?: number
  } = {},
) => {
  let box: string[] = options.draft === undefined ? [] : options.draft.split("\n")
  // The box in its shell mode shows `!` in place of its prompt.
  let bash = options.drafted !== undefined
  if (options.drafted !== undefined) box = [options.drafted]
  let admits = 0
  const profile = profileOf(options.expands ?? true)
  const marker = (first: boolean, line: string): string =>
    first ? `${bash ? "!" : ">"} ${line}` : `  ${line}`
  const written: string[] = []
  const started = Date.now()
  let looks = 0
  let held = false
  let sizes = false
  let holds = 0
  const budgets: HoldBudget[] = []
  let exited = false
  // A screen of fixed height, its box at the bottom, growing up.
  const history = [...(options.history ?? [])]
  let clearAt = 0
  let sent: string[] = []
  const draw = (): string[] => {
    const body = options.noBox
      ? ["a dialog"]
      : box.length === 0 && Date.now() < clearAt
        ? sent.map((line, index) => marker(index === 0, line))
        : box.length === 0
          ? [bash ? "!" : "> "]
          : box.map((line, index) => marker(index === 0, line))
    const top = [options.spinner ? `spinner ${looks}` : "header", "", ...history]
    return [
      ...top,
      ...Array<string>(Math.max(0, 14 - top.length - body.length)).fill(""),
      ...body,
      "footer",
    ]
  }
  const host: PromptHost = {
    admit: () => {
      if (options.refuses) throw options.refuses
      admits += 1
      if (options.refusesLater && admits > (options.laterFrom ?? 2)) throw options.refusesLater
      return profile
    },
    ringing: () =>
      options.ringing !== undefined && Date.now() - started < (options.ringEnds ?? 0)
        ? options.ringing
        : undefined,
    screen: () => {
      looks += 1
      const rows = exited
        ? ["header", "", `$ ${written.join("").length > 0 ? "Hello" : ""}`]
        : draw()
      return Promise.resolve(
        screenOf({
          rows,
          columns: 40,
          // The cursor is on the box's last row, above the footer.
          cursor: { row: exited ? 2 : rows.length - 2, column: 2 },
          bracketedPaste: options.bracketedPaste ?? true,
        }),
      )
    },
    type: (_, data) => {
      written.push(data)
      if (data === "!" && options.shell && !bash && box.length === 0) {
        const on = (): void => {
          bash = true
        }
        if (options.bangMs === undefined) on()
        else setTimeout(on, options.bangMs)
        return true
      }
      // A Backspace on the lone `!` leaves the shell mode.
      if (data === "\x7f" && bash && box.length === 0) {
        bash = false
        return true
      }
      // Enter sends the box's text as a turn, whose echo joins the history above it.
      if (data === "\r" && box.length > 0) {
        history.push(`${bash ? "!" : ">"} ${box.join(" ")}`, "", "Done.")
        sent = box
        clearAt = Date.now() + (options.clearMs ?? 0)
        box = []
        bash = false
        return true
      }
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)?.[1] // eslint-disable-line no-control-regex -- A bracketed paste's markers.
      if (pasted === undefined || options.takes === "nothing") return true
      if (options.lateDraft !== undefined) box = options.lateDraft.split("\n")
      if (options.takes === "placeholder") box = [...box.slice(0, -1), "[Pasted text #1 +4 lines]"]
      else {
        const [first = "", ...rest] = pasted.split("\r")
        // A paste goes where the cursor is: after what the box holds already.
        box = [...box.slice(0, -1), `${box.at(-1) ?? ""}${first}`, ...rest]
      }
      if (options.shellsPaste) bash = true
      if (options.exits) exited = true
      return true
    },
  }
  // The resizes of a hold let go are taken over by the next one, as the manager does.
  let current = 0
  const hold = (budget: HoldBudget): InputHold => {
    budgets.push(budget)
    if (held)
      return {
        release: () => {},
        settle: () => {},
        settleAfter: () => {},
        holding: () => false,
        discard: () => {},
      }
    holds += 1
    held = true
    sizes = true
    const mine = (current += 1)
    const lapse =
      options.holdMs === undefined ? undefined : setTimeout(() => (held = false), options.holdMs)
    const release = () => {
      clearTimeout(lapse)
      if (current === mine) held = false
    }
    return {
      release,
      settle: () => {
        release()
        if (current === mine) sizes = false
      },
      settleAfter: (ms) => {
        const timer = setTimeout(() => {
          release()
          if (current === mine) sizes = false
        }, ms)
        timer.unref()
      },
      holding: () => held && current === mine,
      discard: () => {},
    }
  }
  const queue = new InputQueue({ hold: (_, budget) => hold(budget) })
  return {
    host: Object.assign(host, { queue }),
    written,
    budgets,
    state: () => ({ held, sizes, holds }),
  }
}

const fast = { pollMs: 5, pasteMs: 150, ringMs: 100, settleMs: 40, emptyMs: 60 }
const refused = (text: string, options?: { shell?: boolean }) => refusedBy(text, options)
const enters = (written: readonly string[]) => written.filter((data) => data === "\r").length
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error)
  }
  return "none"
}

const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join("\n")

describe("prompts a TUI would read as more than a message", () => {
  it("are refused: a leading / or !, and an @ mention left open at the end", () => {
    expect(refused("!ls")).toBeDefined()
    for (const text of [
      "/tmp is full",
      "!rm -rf x",
      "  /clear",
      "look at @READ",
      "see @",
      "@a",
      "look at $skill",
      "list $",
      "see $pdf2",
      "see $s3-upload",
      "see $a.b",
      "see $ns:skill",
      "hi\f",
      "\x0bhi",
      "\r",
      "   ",
    ])
      expect(refused(text)).toBeDefined()
    // An @ inside a word, or followed by more words, is text.
    for (const text of [
      "mail a@b.co",
      "@README.md what is this",
      "fix the @no thing",
      "what is 1/2",
      "it costs $5",
      "see $1.50",
      "see $é",
      "one\r\ntwo\rthree",
      "#note this",
      "& what now",
    ])
      expect(refused(text)).toBeUndefined()
  })

  it("are shell commands, with `shell`, where a command follows the ! and it ends in no mention", () => {
    for (const text of ["!ls", "! git status", "  !echo a\nls b", "!echo $5"])
      expect(refused(text, { shell: true })).toBeUndefined()
    for (const text of ["!", "!  ", "  !\n", "!echo $", "!echo @x", "!echo @", "!ls\x1b", "/clear"])
      expect(refused(text, { shell: true })).toBeDefined()
  })

  it("refuse control characters, which would end the paste early and type keys, writing nothing", async () => {
    const { host, written } = terminal()
    const injection = "x\x1b[201~\x15!touch /tmp/pwned\r"
    expect(refused(injection)).toBeDefined()
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", injection))).toBe(
      "PROMPT_REFUSED",
    )
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "a\x7fb"))).toBe(
      "PROMPT_REFUSED",
    )
    expect(written).toEqual([])
    // A line feed and a tab are text; the rule judges the text trimmed, as a client sends it.
    expect(refused("one\ttwo\nthree")).toBeUndefined()
    expect(refused("  /clear  ")).toBeDefined()
  })
})

describe("prompts", () => {
  it("paste a line as one bracketed paste and press Enter once the box shows it", async () => {
    const { host, written, state } = terminal()
    await new Prompts(host, host.queue, fast).prompt("t", "Hello there")
    expect(written).toEqual(["\x1b[200~Hello there\x1b[201~", "\r"])
    expect(state().held).toBe(false)
  })

  it("take a multi-line prompt as one paste whose line breaks are returns", async () => {
    const { host, written } = terminal()
    await new Prompts(host, host.queue, fast).prompt("t", "one\ntwo\r\nthree")
    expect(written).toEqual(["\x1b[200~one\rtwo\rthree\x1b[201~", "\r"])
  })

  it("send a message without the white space around it, a trailing line break included", async () => {
    const { host, written } = terminal()
    await new Prompts(host, host.queue, fast).prompt("t", "\n  Hello there \n\n")
    expect(written).toEqual(["\x1b[200~Hello there\x1b[201~", "\r"])
  })

  it("press Enter on a long paste once the box shows only its placeholder, steady", async () => {
    const { host, written } = terminal({ takes: "placeholder" })
    await new Prompts(host, host.queue, fast).prompt("t", "one\ntwo\nthree\nfour\nfive")
    expect(enters(written)).toBe(1)
  })

  it("never take a placeholder for text a TUI would not collapse", async () => {
    const { host, written } = terminal({ takes: "placeholder" })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe(
      "PROMPT_FAILED",
    )
    expect(enters(written)).toBe(0)
  })

  it("never press Enter after a paste that did not show, and leave the draft", async () => {
    const { host, written, state } = terminal({ takes: "nothing" })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello there"))).toBe(
      "PROMPT_FAILED",
    )
    expect(written).toEqual(["\x1b[200~Hello there\x1b[201~"])
    expect(state()).toMatchObject({ held: false, sizes: false })
  })

  it("never press Enter for a multi-line paste that changed nothing", async () => {
    const { host, written } = terminal({ takes: "nothing" })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "one\ntwo"))).toBe(
      "PROMPT_FAILED",
    )
    expect(enters(written)).toBe(0)
  })

  describe("a short text the screen shows already", () => {
    it.each([
      ["yes", ["Answer yes to continue, or no."]],
      ["1", ["Opus 4.1 · API Usage Billing"]],
      ["go", ["The algorithm is good."]],
      ["Say hello", ["> Say hello", "", "Hello there."]],
    ])("send %s, where the box is empty", async (text, history) => {
      const { host, written } = terminal({ history })
      await new Prompts(host, host.queue, fast).prompt("t", text)
      expect(written).toEqual([`\x1b[200~${text}\x1b[201~`, "\r"])
    })

    it("send the same message twice, each with its own Enter", async () => {
      const { host, written } = terminal({ history: ["> Say hello", "Hello there."] })
      const prompts = new Prompts(host, host.queue, fast)
      await prompts.prompt("t", "Say hello")
      await prompts.prompt("t", "Say hello")
      expect(enters(written)).toBe(2)
    })
  })

  describe("the prompt before it, whose text the TUI is still clearing", () => {
    it("is waited for, one after the other", async () => {
      const { host, written } = terminal({ clearMs: 30 })
      const prompts = new Prompts(host, host.queue, fast)
      await prompts.prompt("t", "First quick")
      await prompts.prompt("t", "Second quick")
      expect(enters(written)).toBe(2)
    })

    it("is waited for, queued together", async () => {
      const { host, written } = terminal({ clearMs: 30 })
      const prompts = new Prompts(host, host.queue, fast)
      await Promise.all([prompts.prompt("t", "Third one"), prompts.prompt("t", "Fourth one")])
      expect(written).toEqual([
        "\x1b[200~Third one\x1b[201~",
        "\r",
        "\x1b[200~Fourth one\x1b[201~",
        "\r",
      ])
    })

    it("is waited for only so long, and a draft that stays is refused", async () => {
      const { host, written } = terminal({ draft: "Mine" })
      const started = Date.now()
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe(
        "CONFLICT",
      )
      expect(Date.now() - started).toBeGreaterThanOrEqual(55)
      expect(written).toEqual([])
    })
  })

  describe("an agent that exits before the text is typed", () => {
    it("never press Enter where the screen turns to a shell's prompt holding the text", async () => {
      const { host, written } = terminal({ exits: true })
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe(
        "PROMPT_FAILED",
      )
      expect(enters(written)).toBe(0)
    })
  })

  it("holds the person's keys for the whole wait and paste, and the resizes past the Enter", async () => {
    const { host, budgets } = terminal()
    await new Prompts(host, host.queue, fast).prompt("t", "Hello")
    // The wait for an empty box, a shell command's switch and the paste's wait, and a
    // margin; then the settle.
    const inputMs = 60 + 2 * 150 + 2_000
    expect(budgets).toEqual([{ inputMs, sizeMs: inputMs + 40 }])
  })

  describe("a box that holds text already", () => {
    it("refuse where it holds the person's draft, writing nothing", async () => {
      const { host, written, state } = terminal({ draft: "Say hello" })
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Shall I go on"))).toBe(
        "CONFLICT",
      )
      expect(written).toEqual([])
      expect(state()).toMatchObject({ held: false, sizes: false })
    })

    it("refuse where it holds what a failed paste left, writing nothing", async () => {
      const { host, written } = terminal({ draft: "[Pasted text #1 +4 lines]" })
      expect(
        await refusal(new Prompts(host, host.queue, fast).prompt("t", "one\ntwo\nthree")),
      ).toBe("CONFLICT")
      expect(written).toEqual([])
    })

    it("refuse a draft of the very text sent, writing nothing", async () => {
      const { host, written } = terminal({ draft: "Hello" })
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe(
        "CONFLICT",
      )
      expect(written).toEqual([])
    })

    it("never press Enter where a draft came with the paste, merged into it", async () => {
      const { host, written } = terminal({ lateDraft: "Say hello" })
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Shall I go on"))).toBe(
        "PROMPT_FAILED",
      )
      expect(enters(written)).toBe(0)
    })

    it("refuse where the screen shows no box, writing nothing", async () => {
      const { host, written } = terminal({ noBox: true })
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe(
        "CONFLICT",
      )
      expect(written).toEqual([])
    })

    it("go on with the next prompt after a refused one", async () => {
      const { host, written } = terminal({ draft: "Draft" })
      const prompts = new Prompts(host, host.queue, fast)
      expect(await refusal(prompts.prompt("t", "First"))).toBe("CONFLICT")
      expect(written).toEqual([])
    })
  })

  describe("a message taller than the box's room on the screen", () => {
    it("is refused where it shows whole and would scroll its first row off, writing nothing", async () => {
      const { host, written, state } = terminal()
      // The screen has 15 rows, so the box has room for 12.
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", lines(13)))).toBe(
        "CONFLICT",
      )
      expect(written).toEqual([])
      expect(state()).toMatchObject({ held: false, sizes: false })
    })

    it("counts the rows a long line wraps to", async () => {
      const { host, written } = terminal()
      // 40 columns leave 38 for text: 6 lines of 77 characters take 18 rows.
      const text = Array.from({ length: 6 }, () => "w".repeat(77)).join("\n")
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", text))).toBe("CONFLICT")
      expect(written).toEqual([])
    })

    it("is sent where it fits", async () => {
      const { host, written } = terminal()
      await new Prompts(host, host.queue, fast).prompt("t", lines(11))
      expect(enters(written)).toBe(1)
    })

    it("is sent where the harness collapses it to a placeholder", async () => {
      const { host, written } = terminal({ takes: "placeholder" })
      await new Prompts(host, host.queue, fast).prompt("t", lines(100))
      expect(enters(written)).toBe(1)
    })
  })

  describe("text a TUI would read as more than a message", () => {
    it.each([
      ["a control character", "Hello\x15there"],
      ["an escape that would end the paste", "Hello\x1b[201~\rmore"],
      ["a DEL", "Hello\x7f"],
      ["a C1 control", "Hello\x9bthere"],
      ["a leading slash", "/clear"],
      ["a leading slash after white space", "  \n/compact"],
      ["a trailing mention", "see @src"],
      ["a bare trailing @", "write to @"],
      ["a trailing $", "use $"],
      ["a trailing skill mention", "run $pdf"],
      ["nothing but white space", " \n\t "],
    ])("refuse %s, writing nothing", async (_, text) => {
      const { host, written } = terminal()
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", text))).toBe(
        "PROMPT_REFUSED",
      )
      expect(written).toEqual([])
    })

    it.each(["Mind the 5$ fee", "mail me@home now", "Say #1 & more?", "Line one\n\tindented"])(
      "send %j",
      async (text) => {
        const { host, written } = terminal()
        await new Prompts(host, host.queue, fast).prompt("t", text)
        expect(enters(written)).toBe(1)
      },
    )
  })

  it("refuse a screen that takes no bracketed paste, writing nothing", async () => {
    const { host, written } = terminal({ bracketedPaste: false })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe("CONFLICT")
    expect(written).toEqual([])
  })

  it("refuse as the host does, writing nothing", async () => {
    const { host, written } = terminal({ refuses: new DomainError("CONFLICT") })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe("CONFLICT")
    expect(written).toEqual([])
  })

  it("abandon a prompt whose hold lapsed before its Enter, pressing nothing", async () => {
    const { host, written } = terminal({ holdMs: 20 })
    // The lapse comes while the screen is looked at, before it has held still.
    const slow: PromptHost = {
      ...host,
      screen: async () => {
        await sleep(30)
        return host.screen("t")
      },
    }
    expect(await refusal(new Prompts(slow, host.queue, fast).prompt("t", "Hello"))).toBe(
      "PROMPT_FAILED",
    )
    expect(enters(written)).toBe(0)
  })

  it("take a line while a spinner changes the screen around its box", async () => {
    const { host, written } = terminal({ spinner: true })
    await new Prompts(host, host.queue, fast).prompt("t", "Then sum it up")
    expect(enters(written)).toBe(1)
  })

  it("give prompts to one terminal one at a time, each with its own Enter", async () => {
    const { host, written } = terminal()
    const prompts = new Prompts(host, host.queue, fast)
    await Promise.all([prompts.prompt("t", "First"), prompts.prompt("t", "Second")])
    expect(written).toEqual(["\x1b[200~First\x1b[201~", "\r", "\x1b[200~Second\x1b[201~", "\r"])
  })

  it("go on with the next prompt after one that failed", async () => {
    const { host, written } = terminal({ takes: "nothing" })
    const prompts = new Prompts(host, host.queue, fast)
    const first = refusal(prompts.prompt("t", "First"))
    const second = refusal(prompts.prompt("t", "Second"))
    expect([await first, await second]).toEqual(["PROMPT_FAILED", "PROMPT_FAILED"])
    expect(written).toHaveLength(2)
  })

  it("wait for a doorbell ring under way to end before it pastes", async () => {
    const { host, written } = terminal({ ringing: "abc", ringEnds: 40 })
    const prompt = new Prompts(host, host.queue, { ...fast, ringMs: 500 }).prompt("t", "Hello")
    await sleep(15)
    expect(written).toEqual([])
    await prompt
    expect(enters(written)).toBe(1)
  })

  it("refuse when a ring outlasts its wait, writing nothing", async () => {
    const { host, written } = terminal({ ringing: "abc", ringEnds: 10_000 })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "Hello"))).toBe("CONFLICT")
    expect(written).toEqual([])
  })

  it("hold the app's resizes past its Enter, which the next prompt takes over", async () => {
    const { host, state } = terminal()
    const prompts = new Prompts(host, host.queue, { ...fast, settleMs: 5_000 })
    await prompts.prompt("t", "First")
    expect(state()).toMatchObject({ held: false, sizes: true })
    await prompts.prompt("t", "Second")
    expect(state().holds).toBe(2)
  })

  it("let the app's resizes go once the wait after its Enter passed", async () => {
    const { host, state } = terminal()
    await new Prompts(host, host.queue, fast).prompt("t", "First")
    await sleep(80)
    expect(state().sizes).toBe(false)
  })
})

describe("shell commands", () => {
  const bang = "\x1b[200~"
  const end = "\x1b[201~"

  it("type the !, wait for a lone !, paste the command and press Enter", async () => {
    const { host, written, state } = terminal({ shell: true })
    await new Prompts(host, host.queue, fast).prompt("t", "  !echo hi > f ")
    expect(written).toEqual(["!", `${bang}echo hi > f${end}`, "\r"])
    expect(state().held).toBe(false)
  })

  it("paste a multi-line command with its line breaks as returns", async () => {
    const { host, written } = terminal({ shell: true, takes: "box" })
    await new Prompts(host, host.queue, fast).prompt("t", "! echo a\r\necho b")
    expect(written).toEqual(["!", `${bang}echo a\recho b${end}`, "\r"])
  })

  it("press Enter for a command a TUI collapsed to a placeholder", async () => {
    const { host, written } = terminal({ shell: true, takes: "placeholder" })
    await new Prompts(host, host.queue, fast).prompt("t", "!one\ntwo\nthree")
    expect(enters(written)).toBe(1)
  })

  it("press no Enter for a collapsed command where the placeholder itself would run", async () => {
    const { host, written } = terminal({ shell: true, takes: "placeholder", expands: false })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "!one\ntwo\nthree"))).toBe(
      "PROMPT_FAILED",
    )
    expect(enters(written)).toBe(0)
  })

  it("say only of a command that never showed that the placeholder kept it back", async () => {
    const { host } = terminal({
      shell: true,
      takes: "box",
      expands: false,
      refusesLater: new DomainError("CONFLICT"),
      laterFrom: 3,
    })
    const failure = await new Prompts(host, host.queue, fast)
      .prompt("t", "!one\ntwo")
      .catch((error: unknown) => error as DomainError)
    expect(failure).toMatchObject({ code: "PROMPT_FAILED" })
    expect((failure as DomainError).message).not.toMatch(/placeholder/)
  })

  it("fail where the lone ! never shows, pasting and pressing nothing more", async () => {
    const { host, written, state } = terminal({ shell: false })
    const failure = await new Prompts(host, host.queue, fast)
      .prompt("t", "!ls")
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DomainError)
    expect((failure as DomainError).code).toBe("PROMPT_FAILED")
    expect((failure as DomainError).message).toMatch(/shell mode/)
    expect(written).toEqual(["!"])
    expect(state()).toMatchObject({ held: false, sizes: false })
  })

  it("never press Enter for a command that did not show after the !", async () => {
    const { host, written } = terminal({ shell: true, takes: "nothing" })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "!ls"))).toBe(
      "PROMPT_FAILED",
    )
    expect(written).toEqual(["!", `${bang}ls${end}`])
  })

  it("take a command run before, whose history row is still on screen, as landed once", async () => {
    const { host, written } = terminal({ shell: true, history: ["! echo hi > f", "output"] })
    await new Prompts(host, host.queue, fast).prompt("t", "!echo hi > f")
    expect(written).toEqual(["!", `${bang}echo hi > f${end}`, "\r"])
  })

  it("press no Enter for a repeated command that never showed again", async () => {
    const { host, written } = terminal({ shell: true, history: ["! ls"], takes: "nothing" })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "!ls"))).toBe(
      "PROMPT_FAILED",
    )
    expect(enters(written)).toBe(0)
  })

  it("take a command among a spinner's changes while a turn runs, queued behind it", async () => {
    const busy = terminal({ shell: true, spinner: true })
    await new Prompts(busy.host, busy.host.queue, fast).prompt("t", "!ls")
    expect(busy.written).toEqual(["!", `${bang}ls${end}`, "\r"])
  })

  it("press no Enter once a request waits on the person after the paste", async () => {
    const { host, written } = terminal({
      shell: true,
      refusesLater: new DomainError("CONFLICT"),
      laterFrom: 3,
    })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "!ls"))).toBe(
      "PROMPT_FAILED",
    )
    expect(enters(written)).toBe(0)
  })

  it("take the ! back out with a Backspace where a request comes before the command's paste", async () => {
    const { host, written, state } = terminal({
      shell: true,
      refusesLater: new DomainError("CONFLICT"),
      laterFrom: 2,
    })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "!rm -rf build"))).toBe(
      "CONFLICT",
    )
    expect(written).toEqual(["!", "\x7f"])
    expect(state()).toMatchObject({ held: false, sizes: false })
  })

  it("leave a ! that showed only after its time, which then keeps any message out", async () => {
    const { host, written } = terminal({ shell: true, bangMs: 600 })
    const prompts = new Prompts(host, host.queue, fast)
    expect(await refusal(prompts.prompt("t", "!ls"))).toBe("PROMPT_FAILED")
    await sleep(700)
    // The box is in its shell mode now: a message there would run as a command.
    expect(await refusal(prompts.prompt("t", "please summarise the README"))).toBe("CONFLICT")
    expect(written).toEqual(["!"])
  })

  it("refuse a message or a command where the box is in its shell mode already, writing nothing", async () => {
    const { host, written } = terminal({ shell: true, drafted: "ls" })
    const prompts = new Prompts(host, host.queue, fast)
    expect(await refusal(prompts.prompt("t", "thanks, now explain it"))).toBe("CONFLICT")
    expect(await refusal(prompts.prompt("t", "!pwd"))).toBe("CONFLICT")
    expect(written).toEqual([])
  })

  it("press no Enter for a message whose box went into its shell mode as it landed", async () => {
    const { host, written } = terminal({ shellsPaste: true })
    expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", "touch it.txt"))).toBe(
      "PROMPT_FAILED",
    )
    expect(enters(written)).toBe(0)
  })

  it("refuse a command or a message where the box can't be read, writing nothing", async () => {
    const { host, written } = terminal({ shell: true, noBox: true })
    const prompts = new Prompts(host, host.queue, fast)
    expect(await refusal(prompts.prompt("t", "!ls"))).toBe("CONFLICT")
    expect(await refusal(prompts.prompt("t", "hello there"))).toBe("CONFLICT")
    expect(written).toEqual([])
  })

  it("refuse a lone ! and a trailing mention, writing nothing", async () => {
    const { host, written } = terminal({ shell: true })
    for (const text of ["!", "! ", "!echo @", "!echo $"])
      // eslint-disable-next-line no-await-in-loop -- One at a time.
      expect(await refusal(new Prompts(host, host.queue, fast).prompt("t", text))).toBe(
        "PROMPT_REFUSED",
      )
    expect(written).toEqual([])
  })
})
