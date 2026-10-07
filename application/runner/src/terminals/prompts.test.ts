import { setTimeout as sleep } from "node:timers/promises"

import { DomainError } from "../errors.js"
import type { BoxProfile, InputBox } from "../harnesses/box.js"
import { describe, expect, it } from "../test.js"
import { screen as screenOf } from "../testing/screens.js"
import { Prompts, type HoldBudget, type PromptHost } from "./prompts.js"
import type { ScreenText } from "./screen.js"

/**
 * An adapter for the fake terminal's box: its first row led by `> `, the rest indented,
 * the lowest such row the box, and `[Pasted text #1 +4 lines]` for a collapsed paste.
 */
const profile: BoxProfile = {
  read: (screen: ScreenText): InputBox | undefined => {
    const first = screen.rows.findLastIndex((row) => row.startsWith("> "))
    if (first < 0) return undefined
    let last = first
    while (screen.rows[last + 1]?.startsWith("  ")) last += 1
    const lines = screen.rows.slice(first, last + 1).map((row) => row.slice(2))
    return { text: lines.join("\n").trimEnd(), first, last }
  },
  collapsed: ({ text }) => /^\[Pasted text #\d+ \+\d+ lines\]$/.test(text),
  queued: () => false,
  collapses: (text) => text.length > 500,
  room: (rows) => rows - 3,
}

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
    /** The nonce of a ring under way, which `ringEnds` ms from the first look ends. */
    ringing?: string
    ringEnds?: number
    /** How long a hold lasts before it lapses by itself, in milliseconds. */
    holdMs?: number
  } = {},
) => {
  let box: string[] = options.draft === undefined ? [] : options.draft.split("\n")
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
        ? sent.map((line, index) => (index === 0 ? `> ${line}` : `  ${line}`))
        : box.length === 0
          ? ["> "]
          : box.map((line, index) => (index === 0 ? `> ${line}` : `  ${line}`))
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
    hold: (_, budget) => {
      budgets.push(budget)
      if (held || sizes) return { release: () => {}, settle: () => {}, holding: () => false }
      holds += 1
      held = true
      sizes = true
      const lapse =
        options.holdMs === undefined ? undefined : setTimeout(() => (held = false), options.holdMs)
      const release = () => {
        clearTimeout(lapse)
        held = false
      }
      return {
        release,
        settle: () => {
          release()
          sizes = false
        },
        holding: () => held,
      }
    },
    type: (_, data) => {
      written.push(data)
      // Enter sends the box's text as a turn, whose echo joins the history above it.
      if (data === "\r" && box.length > 0) {
        history.push(`> ${box.join(" ")}`, "", "Done.")
        sent = box
        clearAt = Date.now() + (options.clearMs ?? 0)
        box = []
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
      if (options.exits) exited = true
      return true
    },
  }
  return { host, written, budgets, state: () => ({ held, sizes, holds }) }
}

const fast = { pollMs: 5, pasteMs: 150, ringMs: 100, settleMs: 40, emptyMs: 60 }
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

describe("prompts", () => {
  it("paste a line as one bracketed paste and press Enter once the box shows it", async () => {
    const { host, written, state } = terminal()
    await new Prompts(host, fast).prompt("t", "Hello there")
    expect(written).toEqual(["\x1b[200~Hello there\x1b[201~", "\r"])
    expect(state().held).toBe(false)
  })

  it("take a multi-line prompt as one paste whose line breaks are returns", async () => {
    const { host, written } = terminal()
    await new Prompts(host, fast).prompt("t", "one\ntwo\r\nthree")
    expect(written).toEqual(["\x1b[200~one\rtwo\rthree\x1b[201~", "\r"])
  })

  it("send a message without the white space around it, a trailing line break included", async () => {
    const { host, written } = terminal()
    await new Prompts(host, fast).prompt("t", "\n  Hello there \n\n")
    expect(written).toEqual(["\x1b[200~Hello there\x1b[201~", "\r"])
  })

  it("press Enter on a long paste once the box shows only its placeholder, steady", async () => {
    const { host, written } = terminal({ takes: "placeholder" })
    await new Prompts(host, fast).prompt("t", "one\ntwo\nthree\nfour\nfive")
    expect(enters(written)).toBe(1)
  })

  it("never take a placeholder for text a TUI would not collapse", async () => {
    const { host, written } = terminal({ takes: "placeholder" })
    expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("PROMPT_FAILED")
    expect(enters(written)).toBe(0)
  })

  it("never press Enter after a paste that did not show, and leave the draft", async () => {
    const { host, written, state } = terminal({ takes: "nothing" })
    expect(await refusal(new Prompts(host, fast).prompt("t", "Hello there"))).toBe("PROMPT_FAILED")
    expect(written).toEqual(["\x1b[200~Hello there\x1b[201~"])
    expect(state()).toMatchObject({ held: false, sizes: false })
  })

  it("never press Enter for a multi-line paste that changed nothing", async () => {
    const { host, written } = terminal({ takes: "nothing" })
    expect(await refusal(new Prompts(host, fast).prompt("t", "one\ntwo"))).toBe("PROMPT_FAILED")
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
      await new Prompts(host, fast).prompt("t", text)
      expect(written).toEqual([`\x1b[200~${text}\x1b[201~`, "\r"])
    })

    it("send the same message twice, each with its own Enter", async () => {
      const { host, written } = terminal({ history: ["> Say hello", "Hello there."] })
      const prompts = new Prompts(host, fast)
      await prompts.prompt("t", "Say hello")
      await prompts.prompt("t", "Say hello")
      expect(enters(written)).toBe(2)
    })
  })

  describe("the prompt before it, whose text the TUI is still clearing", () => {
    it("is waited for, one after the other", async () => {
      const { host, written } = terminal({ clearMs: 30 })
      const prompts = new Prompts(host, fast)
      await prompts.prompt("t", "First quick")
      await prompts.prompt("t", "Second quick")
      expect(enters(written)).toBe(2)
    })

    it("is waited for, queued together", async () => {
      const { host, written } = terminal({ clearMs: 30 })
      const prompts = new Prompts(host, fast)
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
      expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("CONFLICT")
      expect(Date.now() - started).toBeGreaterThanOrEqual(55)
      expect(written).toEqual([])
    })
  })

  describe("an agent that exits before the text is typed", () => {
    it("never press Enter where the screen turns to a shell's prompt holding the text", async () => {
      const { host, written } = terminal({ exits: true })
      expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("PROMPT_FAILED")
      expect(enters(written)).toBe(0)
    })
  })

  it("holds the person's keys for the whole wait and paste, and the resizes past the Enter", async () => {
    const { host, budgets } = terminal()
    await new Prompts(host, fast).prompt("t", "Hello")
    // The wait for an empty box, the paste's wait and a margin; then the settle.
    expect(budgets).toEqual([{ inputMs: 60 + 150 + 2_000, sizeMs: 60 + 150 + 2_000 + 40 }])
  })

  describe("a box that holds text already", () => {
    it("refuse where it holds the person's draft, writing nothing", async () => {
      const { host, written, state } = terminal({ draft: "Say hello" })
      expect(await refusal(new Prompts(host, fast).prompt("t", "Shall I go on"))).toBe("CONFLICT")
      expect(written).toEqual([])
      expect(state()).toMatchObject({ held: false, sizes: false })
    })

    it("refuse where it holds what a failed paste left, writing nothing", async () => {
      const { host, written } = terminal({ draft: "[Pasted text #1 +4 lines]" })
      expect(await refusal(new Prompts(host, fast).prompt("t", "one\ntwo\nthree"))).toBe("CONFLICT")
      expect(written).toEqual([])
    })

    it("refuse a draft of the very text sent, writing nothing", async () => {
      const { host, written } = terminal({ draft: "Hello" })
      expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("CONFLICT")
      expect(written).toEqual([])
    })

    it("never press Enter where a draft came with the paste, merged into it", async () => {
      const { host, written } = terminal({ lateDraft: "Say hello" })
      expect(await refusal(new Prompts(host, fast).prompt("t", "Shall I go on"))).toBe(
        "PROMPT_FAILED",
      )
      expect(enters(written)).toBe(0)
    })

    it("refuse where the screen shows no box, writing nothing", async () => {
      const { host, written } = terminal({ noBox: true })
      expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("CONFLICT")
      expect(written).toEqual([])
    })

    it("go on with the next prompt after a refused one", async () => {
      const { host, written } = terminal({ draft: "Draft" })
      const prompts = new Prompts(host, fast)
      expect(await refusal(prompts.prompt("t", "First"))).toBe("CONFLICT")
      expect(written).toEqual([])
    })
  })

  describe("a message taller than the box's room on the screen", () => {
    it("is refused where it shows whole and would scroll its first row off, writing nothing", async () => {
      const { host, written, state } = terminal()
      // The screen has 15 rows, so the box has room for 12.
      expect(await refusal(new Prompts(host, fast).prompt("t", lines(13)))).toBe("CONFLICT")
      expect(written).toEqual([])
      expect(state()).toMatchObject({ held: false, sizes: false })
    })

    it("counts the rows a long line wraps to", async () => {
      const { host, written } = terminal()
      // 40 columns leave 38 for text: 6 lines of 77 characters take 18 rows.
      const text = Array.from({ length: 6 }, () => "w".repeat(77)).join("\n")
      expect(await refusal(new Prompts(host, fast).prompt("t", text))).toBe("CONFLICT")
      expect(written).toEqual([])
    })

    it("is sent where it fits", async () => {
      const { host, written } = terminal()
      await new Prompts(host, fast).prompt("t", lines(11))
      expect(enters(written)).toBe(1)
    })

    it("is sent where the harness collapses it to a placeholder", async () => {
      const { host, written } = terminal({ takes: "placeholder" })
      await new Prompts(host, fast).prompt("t", lines(100))
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
      ["a leading bang", "!ls"],
      ["a leading slash after white space", "  \n/compact"],
      ["a trailing mention", "see @src"],
      ["a bare trailing @", "write to @"],
      ["a trailing $", "use $"],
      ["a trailing skill mention", "run $pdf"],
      ["nothing but white space", " \n\t "],
    ])("refuse %s, writing nothing", async (_, text) => {
      const { host, written } = terminal()
      expect(await refusal(new Prompts(host, fast).prompt("t", text))).toBe("PROMPT_REFUSED")
      expect(written).toEqual([])
    })

    it.each(["Mind the 5$ fee", "mail me@home now", "Say #1 & more?", "Line one\n\tindented"])(
      "send %j",
      async (text) => {
        const { host, written } = terminal()
        await new Prompts(host, fast).prompt("t", text)
        expect(enters(written)).toBe(1)
      },
    )
  })

  it("refuse a screen that takes no bracketed paste, writing nothing", async () => {
    const { host, written } = terminal({ bracketedPaste: false })
    expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("CONFLICT")
    expect(written).toEqual([])
  })

  it("refuse as the host does, writing nothing", async () => {
    const { host, written } = terminal({ refuses: new DomainError("CONFLICT") })
    expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("CONFLICT")
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
    expect(await refusal(new Prompts(slow, fast).prompt("t", "Hello"))).toBe("PROMPT_FAILED")
    expect(enters(written)).toBe(0)
  })

  it("take a line while a spinner changes the screen around its box", async () => {
    const { host, written } = terminal({ spinner: true })
    await new Prompts(host, fast).prompt("t", "Then sum it up")
    expect(enters(written)).toBe(1)
  })

  it("give prompts to one terminal one at a time, each with its own Enter", async () => {
    const { host, written } = terminal()
    const prompts = new Prompts(host, fast)
    await Promise.all([prompts.prompt("t", "First"), prompts.prompt("t", "Second")])
    expect(written).toEqual(["\x1b[200~First\x1b[201~", "\r", "\x1b[200~Second\x1b[201~", "\r"])
  })

  it("go on with the next prompt after one that failed", async () => {
    const { host, written } = terminal({ takes: "nothing" })
    const prompts = new Prompts(host, fast)
    const first = refusal(prompts.prompt("t", "First"))
    const second = refusal(prompts.prompt("t", "Second"))
    expect([await first, await second]).toEqual(["PROMPT_FAILED", "PROMPT_FAILED"])
    expect(written).toHaveLength(2)
  })

  it("wait for a doorbell ring under way to end before it pastes", async () => {
    const { host, written } = terminal({ ringing: "abc", ringEnds: 40 })
    const prompt = new Prompts(host, { ...fast, ringMs: 500 }).prompt("t", "Hello")
    await sleep(15)
    expect(written).toEqual([])
    await prompt
    expect(enters(written)).toBe(1)
  })

  it("refuse when a ring outlasts its wait, writing nothing", async () => {
    const { host, written } = terminal({ ringing: "abc", ringEnds: 10_000 })
    expect(await refusal(new Prompts(host, fast).prompt("t", "Hello"))).toBe("CONFLICT")
    expect(written).toEqual([])
  })

  it("hold the app's resizes past its Enter, and let go for the next prompt at once", async () => {
    const { host, state } = terminal()
    const prompts = new Prompts(host, { ...fast, settleMs: 5_000 })
    await prompts.prompt("t", "First")
    expect(state()).toMatchObject({ held: false, sizes: true })
    await prompts.prompt("t", "Second")
    expect(state().holds).toBe(2)
  })

  it("let the app's resizes go once the wait after its Enter passed", async () => {
    const { host, state } = terminal()
    await new Prompts(host, fast).prompt("t", "First")
    await sleep(80)
    expect(state().sizes).toBe(false)
  })
})
