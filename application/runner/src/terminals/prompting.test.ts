import type { ScreenText } from "@novadeck/emulator/headless"
import { screen as screenOf } from "@novadeck/harness-core/testing/screens"
import { promptRefusal as refusedBy } from "@novadeck/protocol"
import { InputQueue, PromptRefusal, type PromptRefusalReason } from "@novadeck/tui-input"
import type { BoxProfile } from "@novadeck/tui-input/box"

import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { Interrupts, Prompts, promptError } from "./prompting.js"

const refused = (text: string, options?: { shell?: boolean }) => refusedBy(text, options)

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
})

/** A host whose terminal is never reached: a prompt refused by its text writes nothing. */
const untouched = () => {
  const written: string[] = []
  const queue = new InputQueue({
    hold: () => {
      throw new Error("the queue was reached")
    },
  })
  const never = (): never => {
    throw new Error("the terminal was reached")
  }
  return {
    written,
    prompts: new Prompts(
      {
        admit: never,
        bound: never,
        ringing: never,
        screen: never,
        type: (_, data) => {
          written.push(data)
          return true
        },
      },
      queue,
    ),
  }
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
  } catch (error) {
    return error
  }
  return undefined
}

describe("prompts the library is given this app's rule for", () => {
  it.each([
    ["a control character", "Hello\x15there"],
    ["an escape that would end the paste", "x\x1b[201~\x15!touch /tmp/pwned\r"],
    ["a DEL", "a\x7fb"],
    ["a C1 control", "Hello\x9bthere"],
    ["a leading slash", "/clear"],
    ["a leading slash after white space", "  \n/compact"],
    ["a trailing mention", "see @src"],
    ["a trailing skill mention", "run $pdf"],
    ["nothing but white space", " \n\t "],
    ["a lone !", "!"],
    ["a lone ! and white space", "! "],
    ["a shell command ending in a mention", "!echo @"],
    ["a shell command ending in a skill", "!echo $"],
  ])("refuse %s with PROMPT_REFUSED and its wording, writing nothing", async (_, text) => {
    const { prompts, written } = untouched()
    const failure = await rejection(prompts.prompt("t", text))
    expect(failure).toBeInstanceOf(DomainError)
    expect(failure).toMatchObject({
      code: "PROMPT_REFUSED",
      message: refusedBy(text, { shell: true }),
    })
    expect(written).toEqual([])
  })

  it("refuse the words that follow an answer alike", async () => {
    const { prompts } = untouched()
    const entry = {} as Parameters<Prompts["promptIn"]>[0]
    expect(await rejection(prompts.promptIn(entry, "t", "/clear"))).toMatchObject({
      code: "PROMPT_REFUSED",
    })
  })
})

describe("the contract's errors for what the library refuses", () => {
  const error = (reason: PromptRefusalReason, message = "library's wording") =>
    promptError(new PromptRefusal(reason, message))

  it("keep the codes, reasons and wording clients read", () => {
    const conflict = (reason: string, message: string) =>
      expect.objectContaining({ code: "CONFLICT", reason, message, data: undefined })
    expect(error("no-paste")).toEqual(
      conflict("no-paste", "The agent's screen takes no bracketed paste."),
    )
    expect(error("no-box")).toEqual(
      conflict("no-box", "The agent's input box is not on its screen."),
    )
    expect(error("shell-mode")).toEqual(
      conflict(
        "shell",
        "The agent's input box is in its shell mode: clear it in the terminal first.",
      ),
    )
    expect(error("draft")).toEqual(
      conflict(
        "draft",
        "The agent's input box holds text already: a draft the prompt would merge into.",
      ),
    )
    expect(error("too-tall")).toEqual(
      conflict(
        "too-tall",
        "The message is too tall for the agent's input box on this screen: make the terminal larger or the message shorter.",
      ),
    )
    expect(error("ringing")).toEqual(
      conflict("ringing", "A message's doorbell is ringing the agent."),
    )
    expect(error("gone")).toMatchObject({ code: "TERMINAL_NOT_FOUND" })
    expect(error("refused", "Because.")).toMatchObject({
      code: "PROMPT_REFUSED",
      message: "Because.",
    })
    expect(error("unrunnable")).toMatchObject({
      code: "PROMPT_REFUSED",
      message: expect.stringMatching(/^The agent's shell runs only a command's first line/),
    })
    expect(error("not-switched")).toMatchObject({
      code: "PROMPT_FAILED",
      message: "The agent's input box did not switch to its shell mode.",
    })
    expect(error("not-shown")).toMatchObject({
      code: "PROMPT_FAILED",
      message: "The prompt did not show in the agent's input box.",
    })
    expect(error("unexpanded")).toMatchObject({
      code: "PROMPT_FAILED",
      message: expect.stringMatching(/^The agent shows a command this long as a placeholder/),
    })
  })
})

describe("interrupts", () => {
  /** A terminal whose turn works, its box empty until the Escape, then holding `after`. */
  const stopped = (after: string, options: { clear?: boolean } = {}) => {
    let escaped = false
    let cleared = false
    const profile: BoxProfile = {
      read: (screen: ScreenText) => {
        const first = screen.rows.findIndex((row) => row.startsWith("> "))
        return first < 0
          ? undefined
          : { text: screen.rows[first]!.slice(2).trimEnd(), mode: "prompt", first, last: first }
      },
      collapsed: () => false,
      ...(options.clear ? { clear: () => "\x15" } : {}),
      shell: { expands: true, starts: false, footer: () => false },
      queued: () => false,
      overlay: () => false,
      collapses: () => false,
      room: (rows) => rows - 3,
    }
    return new Interrupts(
      {
        admit: () => undefined,
        working: () => true,
        alive: () => true,
        profile: () => profile,
        prompt: () => "the turn's own",
        screen: () =>
          Promise.resolve(
            screenOf({ rows: ["header", escaped && !cleared ? `> ${after}` : "> "] }),
          ),
        type: () => {
          escaped = true
          return true
        },
        write: () => {
          cleared = true
          return true
        },
      },
      { restoreMs: 300, restoreCalmMs: 50, settleMs: 0 },
    )
  }

  it("answer BOX_NOT_CLEARED, as always, where text stays that clearing would lose", async () => {
    const failure = await rejection(stopped("queued words").interrupt("t"))
    expect(failure).toBeInstanceOf(DomainError)
    expect(failure).toMatchObject({
      code: "BOX_NOT_CLEARED",
      message:
        "The turn is stopped, but the agent's input box holds the message you queued: clear it in the terminal.",
    })
  })

  it("answer returned: null where nothing is given back", async () => {
    expect(await stopped("the turn's own", { clear: true }).interrupt("t")).toEqual({
      returned: null,
    })
  })
})
