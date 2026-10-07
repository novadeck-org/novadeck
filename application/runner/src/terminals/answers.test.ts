import { requestAnswer } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { DialogAdapter, RequestFacts } from "../harnesses/dialogs.js"
import { describe, expect, it } from "../test.js"
import { fakeAdapter, FakeTui } from "../testing/dialogs.js"
import { screen } from "../testing/screens.js"
import { Answers, type AnswerHost } from "./answers.js"
import { identified } from "./dialogs.js"

const facts: RequestFacts = {
  kind: "permission",
  tool: "Bash",
  input: { command: "ls" },
  cwd: null,
}

/** A terminal running the fake TUI, as the answer driver sees it. */
const terminal = (
  options: {
    adapter?: boolean
    /** The third option sends the person's words as the next prompt, pressing "2". */
    prompting?: boolean
    /** The agent takes no prompt after the answer. */
    promptFails?: boolean
    /** Other requests answered already. */
    answeredRefs?: string[]
    /** What its dialog reads as changes after the first look. */
    drift?: boolean
    /** Its dialog is questions that may be set aside to talk over: how, or null. */
    chat?: "field" | "prompt" | null
    /** Its keys come with a few hundred seconds' worth of waits, which hold at once. */
    longSteps?: boolean
    /** Whether the other request "r2" still waits. */
    twinWaits?: () => boolean
    /** Other requests waiting. */
    others?: { ref: string; actor?: string | null; facts: RequestFacts }[]
    /** Whether the request is still waiting; false once it is answered elsewhere. */
    waiting?: () => boolean
    shown?: boolean
    /** The tracker shows its dialog raw. */
    raw?: boolean
    /** Refusals the words' prompt meets, one per try, before it goes. */
    refusals?: DomainError[]
    /** Whether the agent's turn runs, per its hooks. */
    working?: boolean
    /** Runs after each write, as the TUI redraws. */
    after?: (tui: FakeTui) => void
  } = {},
) => {
  const tui = new FakeTui()
  const calls: string[] = []
  const locks: string[] = []
  let closed = false
  let busy = 0
  let holds = 0
  let settled = 0
  const adapter = (): DialogAdapter => {
    const plain = fakeAdapter()
    if (options.chat !== undefined) {
      const { chat } = options
      return {
        read: (rows, each) => {
          const read = plain.read(rows, each)
          return (
            read && {
              ...read,
              dialog: {
                type: "questions" as const,
                questions: [
                  {
                    id: "q1",
                    header: null,
                    question: "Which?",
                    options: [],
                    multiSelect: false,
                    text: true,
                  },
                ],
                chat,
              },
              keys: () => [{ press: "1" }],
            }
          )
        },
      }
    }
    if (options.drift) {
      let reads = 0
      return {
        read: (rows, each) => {
          const read = plain.read(rows, each)
          reads += 1
          if (!read || reads <= 1 || read.dialog.type !== "choices") return read
          return { ...read, dialog: { ...read.dialog, title: "something else" } }
        },
      }
    }
    if (options.longSteps)
      return {
        read: (rows, each) => {
          const read = plain.read(rows, each)
          return (
            read && {
              ...read,
              keys: (answer) => [
                ...Array.from({ length: 40 }, () => ({
                  until: () => true,
                  timeoutMs: 8_000,
                  why: "nothing",
                })),
                ...(read.keys(answer) ?? []),
              ],
            }
          )
        },
      }
    if (!options.prompting) return plain
    return {
      read: (rows, each) => {
        const read = plain.read(rows, each)
        if (!read || read.dialog.type !== "choices") return read
        return {
          ...read,
          dialog: {
            ...read.dialog,
            options: read.dialog.options.map((option) =>
              option.id === "3" ? { ...option, text: "prompt" as const } : option,
            ),
          },
          keys: (answer) =>
            read.keys(
              answer.type === "choice" && answer.option === "3"
                ? { ...answer, option: "2" }
                : answer,
            ),
        }
      },
    }
  }
  const host: AnswerHost = {
    request: (_terminal, ref) =>
      ref === "r2"
        ? options.twinWaits?.() === false
          ? undefined
          : { facts, actor: null, adapter: adapter(), others: [] }
        : ref === "r1" && (options.waiting?.() ?? true)
          ? {
              facts,
              actor: null,
              adapter: options.adapter === false ? undefined : adapter(),
              others: (options.others ?? []).map((other) => ({ actor: null, ...other })),
            }
          : undefined,
    ringing: () => undefined,
    screen: () => Promise.resolve(tui.screen()),
    hold: () => {
      holds += 1
      return {
        release: () => calls.push("release"),
        settle: () => (settled += 1),
        holding: () => true,
        discard: () => calls.push("discard"),
      }
    },
    type: (_terminal, data) => {
      tui.write(data)
      options.after?.(tui)
      return true
    },
    prompt: (_terminal, text) => {
      calls.push(`prompt ${text}`)
      const refusal = options.refusals?.shift()
      if (refusal) return Promise.reject(refusal)
      return options.promptFails ? Promise.reject(new Error("no")) : Promise.resolve()
    },
    working: () => options.working ?? false,
    closed: () => closed,
    answered: (_terminal, ref) => options.answeredRefs?.includes(ref) ?? false,
    shown: () => options.shown ?? true,
    raw: () => options.raw ?? false,
    lock: (_terminal, _ref, reason) => {
      locks.push(reason)
      closed = true
    },
    done: () => {
      closed = true
      calls.push("done")
    },
    busy: (_terminal, on) => {
      busy += on ? 1 : -1
    },
  }
  const answers = new Answers(host, {
    stillMs: 5,
    readMs: 100,
    pollMs: 5,
    answeredMs: 100,
    typedMs: 100,
    settleMs: 10,
    followMs: 200,
    calmMs: 200,
  })
  return {
    tui,
    answers,
    calls,
    locks,
    read: () => adapter().read(tui.rows(), facts),
    host,
    busy: () => busy,
    holds: () => holds,
    settled: () => settled,
  }
}

/** The id of the dialog the fake TUI shows now, as the driver fingerprints it. */
const shown = (tui: FakeTui): string => {
  const read = fakeAdapter().read(tui.rows(), facts)
  return read ? identified(read.dialog)!.id : "none"
}

/** Answers the request as the chat would, naming the dialog on screen. */
const give = (
  tui: FakeTui,
  answers: Answers,
  answer: { type: "choice"; option: string; text?: string },
  dialog = shown(tui),
) => answers.answer("t", "r1", { dialog, ...answer })

const values = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}`, "v"]))

const fails = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run
  } catch (error) {
    if (error instanceof DomainError) return error.code
    throw error
  }
  throw new Error("It did not fail.")
}

// A refusal of the words that follow an answer, for the reason given.
const refusal = (reason: "pending" | "ringing" | "held" | "draft" | "no-box") =>
  new DomainError("CONFLICT", "no", undefined, reason)

// The answer that picks option 3 of the dialog read, with words that follow it.
const choose = (read: () => { dialog: Parameters<typeof identified>[0] } | undefined) => ({
  dialog: identified(read()!.dialog)!.id,
  type: "choice" as const,
  option: "3",
  text: "do it differently",
})

describe("answering a request through its dialog", () => {
  it("presses the option's key, holds the person's keys meanwhile and marks it answered", async () => {
    const { tui, answers, calls, busy, holds } = terminal()
    await give(tui, answers, { type: "choice", option: "2" })
    expect(tui.written).toEqual(["2"])
    expect(calls).toEqual(["discard", "release", "done"])
    expect(holds()).toBe(1)
    expect(busy()).toBe(0)
  })

  it("opens a field, types the person's words as one bracketed paste and presses Enter", async () => {
    const { tui, answers } = terminal()
    await give(tui, answers, { type: "choice", option: "3", text: "not that\nthis" })
    expect(tui.written).toEqual(["3", "\x1b[200~not that\rthis\x1b[201~", "\r"])
    expect(tui.field).toBe("not that\rthis")
  })

  it("types it without line breaks where the screen takes no paste", async () => {
    const { tui, answers } = terminal()
    tui.bracketed = false
    await give(tui, answers, { type: "choice", option: "3", text: "one\ntwo" })
    expect(tui.written).toEqual(["3", "one two", "\r"])
  })

  it("types a tab as a space where the screen takes no paste, never as a Tab key", async () => {
    const { tui, answers } = terminal()
    tui.bracketed = false
    await give(tui, answers, { type: "choice", option: "3", text: "one\ttwo" })
    expect(tui.written).toEqual(["3", "one two", "\r"])
  })

  it("lets go of the window's resizes once the keys have", async () => {
    const { tui, answers, settled } = terminal()
    await give(tui, answers, { type: "choice", option: "1" })
    expect(settled()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(settled()).toBe(1)
  })

  it("follows an option that sends the person's words as the next prompt with them, once it took", async () => {
    const { tui, answers, calls, read } = terminal({ prompting: true })
    await give(
      tui,
      answers,
      { type: "choice", option: "3", text: "do it differently" },
      identified(read()!.dialog)!.id,
    )
    expect(tui.written).toEqual(["2"])
    expect(calls).toEqual(["discard", "release", "done", "prompt do it differently"])
  })

  it("is NOT_FOUND for a request the agent doesn't have, pressing nothing", async () => {
    const { tui, answers } = terminal()
    expect(
      await fails(answers.answer("t", "other", { dialog: "x", type: "choice", option: "1" })),
    ).toBe("NOT_FOUND")
    expect(tui.written).toEqual([])
  })

  it("is a CONFLICT for an answer its dialog can't take, pressing nothing and keeping the dialog", async () => {
    const { tui, answers, locks } = terminal()
    // The option takes words and none came; there is no such option.
    expect(await fails(give(tui, answers, { type: "choice", option: "3" }))).toBe("CONFLICT")
    expect(await fails(give(tui, answers, { type: "choice", option: "9" }))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
    expect(locks).toEqual([])
  })

  it("is a CONFLICT, pressing nothing, where the screen shows no dialog it recognises", async () => {
    const { tui, answers, locks } = terminal()
    tui.state = "other"
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
    // It had a dialog showing: that dialog is raw from now on.
    expect(locks).toEqual(["unrecognized"])
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    tui.state = "ask"
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
  })

  it("leaves the dialog as it was where none had shown yet", async () => {
    const { tui, answers, locks } = terminal({ shown: false })
    tui.state = "other"
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(locks).toEqual([])
  })

  it("is a CONFLICT for a harness with no adapter", async () => {
    const { tui, answers } = terminal({ adapter: false })
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
  })

  it("is ANSWER_FAILED where the keys did not take, and never presses for the request again", async () => {
    const { tui, answers, locks, busy } = terminal()
    tui.ignores = true
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("ANSWER_FAILED")
    expect(tui.written).toEqual(["1"])
    expect(locks).toEqual(["failed"])
    expect(busy()).toBe(0)
    tui.ignores = false
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(tui.written).toEqual(["1"])
  })

  it("is ANSWER_FAILED where the field never opens, after its first key", async () => {
    const { tui, answers, locks } = terminal()
    tui.ignores = true
    expect(await fails(give(tui, answers, { type: "choice", option: "3", text: "words" }))).toBe(
      "ANSWER_FAILED",
    )
    expect(tui.written).toEqual(["3"])
    expect(locks).toEqual(["failed"])
  })

  it("reads the dialog once, and goes on through screens the adapter doesn't read", async () => {
    // After its first key the screen shows a state of the dialog's own that reads as nothing.
    const { tui, answers } = terminal({
      after: (each) => {
        if (each.written.length === 1) each.command = "typed"
      },
    })
    await give(tui, answers, { type: "choice", option: "3", text: "words" })
    expect(tui.written).toEqual(["3", "\x1b[200~words\x1b[201~", "\r"])
  })

  it("never presses once the request no longer waits", async () => {
    let waiting = true
    const { tui, answers } = terminal({
      waiting: () => waiting,
      after: () => {
        waiting = false
      },
    })
    expect(await fails(give(tui, answers, { type: "choice", option: "3", text: "words" }))).toBe(
      "ANSWER_FAILED",
    )
    expect(tui.written).toEqual(["3"])
  })

  it("answers one at a time per terminal", async () => {
    const { tui, answers } = terminal()
    const first = give(tui, answers, { type: "choice", option: "1" })
    const second = give(tui, answers, { type: "choice", option: "2" })
    await first
    expect(await fails(second)).toBe("CONFLICT")
    expect(tui.written).toEqual(["1"])
  })

  it("is a CONFLICT, pressing nothing and locking nothing, for an answer naming another dialog", async () => {
    const { tui, answers, locks } = terminal()
    expect(
      await fails(give(tui, answers, { type: "choice", option: "1" }, "an-older-dialog")),
    ).toBe("DIALOG_CHANGED")
    expect(tui.written).toEqual([])
    expect(locks).toEqual([])
  })

  it("refuses a screen that reads for another request that asks something else too", async () => {
    const { tui, answers } = terminal({
      others: [{ ref: "r2", facts: { ...facts, cwd: "/elsewhere" } }],
    })
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
  })

  it("answers through a twin, a request asking the very same, without marking it answered", async () => {
    let twinWaits = true
    const { tui, answers, calls } = terminal({
      others: [{ ref: "r2", facts }],
      twinWaits: () => twinWaits,
      after: (each) => {
        // The hook resolves the twin; the screen moved on a little, the same dialog still up.
        twinWaits = false
        each.noise += 1
      },
    })
    // The next twin's identical dialog shows as the first goes: the screen doesn't change.
    tui.ignores = true
    await give(tui, answers, { type: "choice", option: "1" })
    expect(tui.written).toEqual(["1"])
    // This request waits still, for the dialog that shows next: it is not done.
    expect(calls).not.toContain("done")
  })

  it("waits for a screen that is still drawing before it reads", async () => {
    const { tui, answers } = terminal()
    // The noise row changes with every look for a while, as a redraw does.
    let looks = 0
    const drawn = tui.screen.bind(tui)
    tui.screen = () => {
      looks += 1
      if (looks < 6) tui.noise = looks
      return drawn()
    }
    await give(tui, answers, { type: "choice", option: "1" })
    expect(looks).toBeGreaterThan(6)
    expect(tui.written).toEqual(["1"])
  })

  it("reads again before refusing a dialog that was half drawn", async () => {
    const { tui, answers, locks } = terminal()
    tui.state = "other"
    setTimeout(() => (tui.state = "ask"), 30)
    await give(tui, answers, { type: "choice", option: "1" }, shown(new FakeTui()))
    expect(tui.written).toEqual(["1"])
    expect(locks).toEqual([])
  })

  it("is ANSWER_FAILED where typed text never shows, pressing no Enter", async () => {
    const { tui, answers } = terminal()
    // The field takes keys but draws none of the text.
    const write = tui.write.bind(tui)
    tui.write = (data) => {
      write(data)
      tui.field = ""
    }
    expect(await fails(give(tui, answers, { type: "choice", option: "3", text: "words" }))).toBe(
      "ANSWER_FAILED",
    )
    expect(tui.written).not.toContain("\r")
  })

  it("drops what the person typed meanwhile, and takes the request gone as answered", async () => {
    let waiting = true
    const { tui, answers, calls } = terminal({
      waiting: () => waiting,
      after: () => {
        // Its hook says it was answered, though the screen shows no known post-state.
        waiting = false
      },
    })
    tui.ignores = false
    await give(tui, answers, { type: "choice", option: "2" })
    expect(calls.slice(0, 2)).toEqual(["discard", "release"])
  })

  it("refuses an answer that outlasts the longest the keys can be held", async () => {
    const t = terminal()
    const short = new Answers(t.host, { stillMs: 5, readMs: 100, pollMs: 5, holdMs: 1_000 })
    expect(
      await fails(
        short.answer("t", "r1", {
          dialog: shown(t.tui),
          type: "choice",
          option: "3",
          text: "words",
        }),
      ),
    ).toBe("CONFLICT")
    expect(t.tui.written).toEqual([])
  })

  it("takes the dialog gone for another request's as answered, as queued permissions are", async () => {
    const next: RequestFacts = { ...facts, input: { command: "pwd" } }
    const { tui, answers } = terminal({
      others: [{ ref: "r2", facts: next }],
      after: (each) => {
        // At once, the next request's dialog takes its place.
        each.command = "pwd"
      },
    })
    await give(tui, answers, { type: "choice", option: "1" })
    expect(tui.written).toEqual(["1"])
  })

  it("is a CONFLICT, locking nothing, where its dialog shows raw and unlocked", async () => {
    const { tui, answers, locks } = terminal({ raw: true })
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
    expect(locks).toEqual([])
  })

  it("leaves a request waiting where its identical dialog shows again at once", async () => {
    // The harness folds twin calls into one request: the next dialog is this one's again.
    let waiting = true
    const { tui, answers, calls } = terminal({
      waiting: () => waiting,
      after: () => {
        // Its hook resolves it, and the same dialog is up again.
        waiting = false
      },
    })
    tui.ignores = true
    await give(tui, answers, { type: "choice", option: "1" })
    expect(calls).not.toContain("done")
  })

  it("takes a twin's vanishing for success only where the screen moved on from the dialog read", async () => {
    const { tui, answers } = terminal({
      others: [{ ref: "r2", facts }],
      twinWaits: () => false,
    })
    // The keys took nothing: the screen is as it was, whatever became of the twin.
    tui.ignores = true
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("ANSWER_FAILED")
  })

  it("refuses twins of different agents, a subagent's dialog showing as the root's", async () => {
    const { tui, answers } = terminal({
      others: [{ ref: "r2", actor: "subagent-1", facts }],
    })
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
  })

  it("holds for a long answer it reads, many waits and all, without refusing it for time", async () => {
    const { tui, answers } = terminal({ longSteps: true })
    await give(tui, answers, { type: "choice", option: "1" })
    expect(tui.written).toEqual(["1"])
  })

  it("sets questions aside to talk, sending the words as the next prompt where their chat is a prompt", async () => {
    const { tui, answers, calls, read } = terminal({ chat: "prompt" })
    await answers.answer("t", "r1", {
      dialog: identified(read()!.dialog)!.id,
      type: "chat",
      text: "Let us discuss",
    })
    expect(tui.written).toEqual(["1"])
    expect(calls).toContain("prompt Let us discuss")
  })

  it("refuses to set aside what has no chat, and a field chat without words, pressing nothing", async () => {
    const none = terminal({ chat: null })
    expect(
      await fails(
        none.answers.answer("t", "r1", {
          dialog: identified(none.read()!.dialog)!.id,
          type: "chat",
          text: "hi",
        }),
      ),
    ).toBe("CONFLICT")
    const field = terminal({ chat: "field" })
    expect(
      await fails(
        field.answers.answer("t", "r1", {
          dialog: identified(field.read()!.dialog)!.id,
          type: "chat",
        }),
      ),
    ).toBe("CONFLICT")
    expect(none.tui.written).toEqual([])
    expect(field.tui.written).toEqual([])
  })

  it("lets an answered other go, but not one that waits still, as a subagent's request", async () => {
    const others = [{ ref: "r2", actor: "subagent-1", facts }]
    const waits = terminal({ others })
    expect(await fails(give(waits.tui, waits.answers, { type: "choice", option: "1" }))).toBe(
      "CONFLICT",
    )
    const done = terminal({ others, answeredRefs: ["r2"] })
    await give(done.tui, done.answers, { type: "choice", option: "1" })
    expect(done.tui.written).toEqual(["1"])
  })

  it("is DIALOG_CHANGED where the screen before the first key reads as another dialog", async () => {
    const { tui, answers, read } = terminal({ drift: true })
    const id = identified(read()!.dialog)!.id
    expect(
      await fails(answers.answer("t", "r1", { dialog: id, type: "choice", option: "1" })),
    ).toBe("DIALOG_CHANGED")
    expect(tui.written).toEqual([])
  })

  it("refuses words that hold control characters, pressing nothing", async () => {
    const { tui, answers } = terminal()
    expect(await fails(give(tui, answers, { type: "choice", option: "3", text: "a\x1b[Bb" }))).toBe(
      "CONFLICT",
    )
    expect(await fails(give(tui, answers, { type: "choice", option: "3", text: "a\x7fb" }))).toBe(
      "CONFLICT",
    )
    expect(tui.written).toEqual([])
  })

  it("takes a form's values for no more than 16 fields", () => {
    const answer = (count: number) =>
      requestAnswer.safeParse({
        type: "form",
        dialog: "d",
        action: "accept",
        values: values(count),
      })
    expect(answer(16).success).toBe(true)
    expect(answer(17).success).toBe(false)
  })

  it("is WORDS_NOT_SENT where the answer took but its following words did not go", async () => {
    const { tui, answers, calls, read } = terminal({ prompting: true, promptFails: true })
    const run = answers.answer("t", "r1", {
      dialog: identified(read()!.dialog)!.id,
      type: "choice",
      option: "3",
      text: "do it differently",
    })
    expect(await fails(run)).toBe("WORDS_NOT_SENT")
    // The dialog was answered: its key went, and it is done.
    expect(tui.written).toEqual(["2"])
    expect(calls).toContain("done")
  })

  describe("the words that follow an answer", () => {
    it.each(["pending", "ringing", "held"] as const)(
      "are tried again while the refusal is %s, which clears by itself",
      async (reason) => {
        const { answers, calls, read } = terminal({
          prompting: true,
          refusals: [refusal(reason), refusal(reason)],
        })
        await answers.answer("t", "r1", choose(read))
        expect(calls.filter((call) => call.startsWith("prompt"))).toHaveLength(3)
      },
    )

    it.each(["draft", "no-box"] as const)(
      "fail at once as WORDS_NOT_SENT where the refusal is %s",
      async (reason) => {
        const { answers, calls, read } = terminal({ prompting: true, refusals: [refusal(reason)] })
        expect(await fails(answers.answer("t", "r1", choose(read)))).toBe("WORDS_NOT_SENT")
        expect(calls.filter((call) => call.startsWith("prompt"))).toHaveLength(1)
      },
    )

    it("give up on a refusal that never clears once their time is up", async () => {
      const { answers, read } = terminal({
        prompting: true,
        refusals: Array.from({ length: 1_000 }, () => refusal("pending")),
      })
      expect(await fails(answers.answer("t", "r1", choose(read)))).toBe("WORDS_NOT_SENT")
    })

    it("wait for the screen to settle before they go, longer while a turn runs", async () => {
      const quiet = terminal({ prompting: true })
      const began = Date.now()
      await quiet.answers.answer("t", "r1", choose(quiet.read))
      const idle = Date.now() - began
      const busy = terminal({ prompting: true, working: true })
      const started = Date.now()
      await busy.answers.answer("t", "r1", choose(busy.read))
      expect(Date.now() - started).toBeGreaterThan(idle)
    })
  })

  it("refuses follow-up words a prompt can't carry before pressing any key", async () => {
    const { tui, answers, calls, read } = terminal({ prompting: true })
    const run = answers.answer("t", "r1", {
      dialog: identified(read()!.dialog)!.id,
      type: "choice",
      option: "3",
      text: "/clear",
    })
    expect(await fails(run)).toBe("PROMPT_REFUSED")
    expect(tui.written).toEqual([])
    expect(calls).not.toContain("done")
  })

  it("refuses follow-up words that start with !, a shell command, pressing no key", async () => {
    const { tui, answers, calls, read } = terminal({ prompting: true })
    const run = answers.answer("t", "r1", {
      dialog: identified(read()!.dialog)!.id,
      type: "choice",
      option: "3",
      text: "!rm -rf x",
    })
    expect(await fails(run)).toBe("PROMPT_REFUSED")
    expect(tui.written).toEqual([])
    expect(calls).not.toContain("done")
  })
})

describe("waiting for an agent's screen to settle before words follow an answer", () => {
  type Calm = { calm: (id: string) => Promise<void> }
  /** Answers on a screen that `drawing` changes on each look, with the default waits. */
  const settling = (options: { working?: boolean; drawing?: boolean; gone?: boolean }) => {
    const { host } = terminal({ working: options.working ?? false })
    let looks = 0
    const answers = new Answers(
      {
        ...host,
        screen: () => {
          looks += 1
          if (options.gone) return Promise.resolve(undefined)
          return Promise.resolve(screen({ rows: [options.drawing ? `tick ${looks}` : "still"] }))
        },
      },
      {},
    )
    return (answers as unknown as Calm).calm("t")
  }

  it("settles once a still screen has no turn running, after 0.6 s", async () => {
    const started = Date.now()
    await settling({})
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(550)
    expect(took).toBeLessThan(1_400)
  })

  it("settles after 1.5 s of a still screen whatever the activity says", async () => {
    const started = Date.now()
    await settling({ working: true })
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(1_450)
    expect(took).toBeLessThan(2_600)
  })

  it("gives up after 6 s on a screen that never holds still, and goes on", async () => {
    const started = Date.now()
    await settling({ drawing: true })
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(5_900)
    expect(took).toBeLessThan(7_500)
  })

  it("returns at once for a terminal that is gone", async () => {
    const started = Date.now()
    await settling({ gone: true })
    expect(Date.now() - started).toBeLessThan(300)
  })
})
