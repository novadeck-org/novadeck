import type { DialogAdapter, RequestFacts } from "@novadeck/harness-core/dialogs"
import { fakeAdapter, FakeTui } from "@novadeck/harness-core/testing/dialogs"
import { screen } from "@novadeck/harness-core/testing/screens"
import { requestAnswer } from "@novadeck/protocol"
import { InputQueue } from "@novadeck/tui-input"
import { afterEach, vi } from "vitest"

import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { Answers, type AnswersHost } from "./answers.js"
import { identified } from "./dialogs.js"

// The answer driver's sleeps go through the global setTimeout, so a case that times them runs
// them on a fake clock (see `timed`); every other case gets the real timer, as before.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}))

/**
 * Runs `work` on a fake clock, stepping from each timer that comes due to the next, so a
 * timing is the same on every machine however busy it is. `Date.now` is the fake clock's.
 */
const timed = async <T>(work: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  })
  try {
    const running = work()
    const state = { settled: false }
    running.then(
      () => (state.settled = true),
      () => (state.settled = true),
    )
    for (let step = 0; !state.settled; step += 1) {
      // The longest timed case takes about sixty steps; a thousand is a wait that never ends.
      if (step >= 1_000) throw new Error("The work never ended.")
      // eslint-disable-next-line no-await-in-loop -- One timer at a time.
      await vi.advanceTimersToNextTimerAsync()
    }
    return await running
  } finally {
    vi.useRealTimers()
  }
}

// A timed case that failed by timing out leaves its fake clock behind; the next case doesn't run on it.
afterEach(() => {
  vi.useRealTimers()
})

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
    /** Its dialog is a question answered as the agent's next prompt, pressing nothing. */
    byPrompt?: boolean
    /** Its keys come with a few hundred seconds' worth of waits, which hold at once. */
    longSteps?: boolean
    /** Its keys type words with no check after that they showed. */
    unchecked?: boolean
    /** Whether the other request "r2" still waits. */
    twinWaits?: () => boolean
    /** Other requests waiting; a function gives those waiting at the time it is asked. */
    others?:
      | { ref: string; actor?: string | null; facts: RequestFacts; askedAt?: number }[]
      | (() => { ref: string; actor?: string | null; facts: RequestFacts; askedAt?: number }[])
    /** Whether the request is still waiting; false once it is answered elsewhere. */
    waiting?: () => boolean
    shown?: boolean
    /** The tracker shows its dialog raw. */
    raw?: boolean
    /** Refusals the words' prompt meets, one per try, before it goes. */
    refusals?: DomainError[]
    /** Whether the agent's turn runs, per its hooks. */
    working?: boolean
    /** When the agent's running turn began, on the clock of `Date.now`. */
    turnStartedAt?: () => number | undefined
    /** How long a turn is left to run before the first key, in milliseconds; 10 by default. */
    settleMs?: number
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
    if (options.byPrompt)
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
                    options: [{ id: "1", label: "Blue", description: null }],
                    multiSelect: false,
                    text: true,
                  },
                ],
                chat: null,
              },
              keys: () => [{ press: "1" }],
              prompt: (answer) =>
                answer.type !== "questions"
                  ? undefined
                  : `> Which?\n\n${answer.answers[0]?.text ?? "Blue"}`,
            }
          )
        },
      }
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
    if (options.unchecked)
      return {
        read: (rows, each) => {
          const read = plain.read(rows, each)
          return (
            read && {
              ...read,
              keys: (answer) => read.keys(answer)?.filter((step) => !("until" in step)),
            }
          )
        },
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
  const host: AnswersHost = {
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
              others: (
                (typeof options.others === "function" ? options.others() : options.others) ?? []
              ).map((other) => ({ actor: null, askedAt: 0, ...other })),
            }
          : undefined,
    ringing: () => undefined,
    screen: () => Promise.resolve(tui.screen()),
    press: (_terminal, data) => {
      tui.write(data)
      options.after?.(tui)
      return true
    },
    prompt: (_entry, _terminal, text) => {
      calls.push(`prompt ${text}`)
      const refusal = options.refusals?.shift()
      if (refusal) return Promise.reject(refusal)
      return options.promptFails ? Promise.reject(new Error("no")) : Promise.resolve()
    },
    working: () => options.working ?? false,
    turnStartedAt: () => options.turnStartedAt?.(),
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
  const queue = new InputQueue({
    hold: () => {
      holds += 1
      let released = false
      return {
        release: () => {
          if (!released) calls.push("release")
          released = true
        },
        settle: () => (settled += 1),
        settleAfter: (ms) => void setTimeout(() => (settled += 1), ms).unref(),
        holding: () => true,
        discard: () => calls.push("discard"),
      }
    },
  })
  const answers = new Answers(host, queue, {
    stillMs: 5,
    readMs: 100,
    pollMs: 5,
    answeredMs: 100,
    typedMs: 100,
    settleMs: options.settleMs ?? 10,
    followMs: 200,
    calmMs: 200,
  })
  return {
    tui,
    answers,
    queue,
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
const refusal = (reason: "pending" | "draft" | "no-box") =>
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

  it("presses nothing until the turn that put the dialog up has run for the settle time", () =>
    timed(async () => {
      const began = Date.now()
      let firstKey: number | undefined
      const { tui, answers } = terminal({
        settleMs: 150,
        turnStartedAt: () => began,
        after: () => (firstKey ??= Date.now()),
      })
      await give(tui, answers, { type: "choice", option: "2" })
      // The settle time, then the dialog's two reads, `stillMs` (5 ms here) apart.
      expect(firstKey! - began).toBe(150 + 5)
      expect(tui.written).toEqual(["2"])
    }))

  it("waits for no turn that has not begun, or began long ago", () =>
    timed(async () => {
      for (const turnStartedAt of [undefined, Date.now() - 60_000]) {
        const started = Date.now()
        let firstKey: number | undefined
        const { tui, answers } = terminal({
          settleMs: 150,
          turnStartedAt: () => turnStartedAt,
          after: () => (firstKey ??= Date.now()),
        })
        // eslint-disable-next-line no-await-in-loop -- One after the other, as timed.
        await give(tui, answers, { type: "choice", option: "2" })
        // No settle wait: only the dialog's two reads, 5 ms apart.
        expect(firstKey! - started).toBe(5)
      }
    }))

  it("waits no longer than the settle time for a turn that began, by the clock, in the future", () =>
    timed(async () => {
      const started = Date.now()
      let firstKey: number | undefined
      const { tui, answers } = terminal({
        settleMs: 150,
        turnStartedAt: () => started + 60_000,
        after: () => (firstKey ??= Date.now()),
      })
      await give(tui, answers, { type: "choice", option: "2" })
      // The settle time at most, then the dialog's two reads, 5 ms apart.
      expect(firstKey! - started).toBe(150 + 5)
    }))

  it("refuses a dialog read for a request that registered during the turn's settle wait", () =>
    timed(async () => {
      const others: { ref: string; facts: RequestFacts }[] = []
      const { tui, answers } = terminal({
        settleMs: 100,
        turnStartedAt: () => Date.now(),
        others,
      })
      setTimeout(() => others.push({ ref: "r2", facts: { ...facts, cwd: "/elsewhere" } }), 30)
      expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("CONFLICT")
      expect(tui.written).toEqual([])
    }))

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

  it("lets go of the window's resizes once the keys have", () =>
    timed(async () => {
      const { tui, answers, settled } = terminal()
      await give(tui, answers, { type: "choice", option: "1" })
      expect(settled()).toBe(0)
      // The settle time after the last key, 10 ms here.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(settled()).toBe(1)
    }))

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

  it("waits for a screen that is still drawing before it reads", () =>
    timed(async () => {
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
    }))

  it("reads again before refusing a dialog that was half drawn", () =>
    timed(async () => {
      const { tui, answers, locks } = terminal()
      tui.state = "other"
      setTimeout(() => (tui.state = "ask"), 30)
      await give(tui, answers, { type: "choice", option: "1" }, shown(new FakeTui()))
      expect(tui.written).toEqual(["1"])
      expect(locks).toEqual([])
    }))

  it("presses nothing where its adapter would type words without checking they showed", async () => {
    const { tui, answers } = terminal({ unchecked: true })
    await expect(
      give(tui, answers, { type: "choice", option: "3", text: "words" }),
    ).rejects.toThrow("without a check")
    expect(tui.written).toEqual([])
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
    const short = new Answers(t.host, t.queue, {
      stillMs: 5,
      readMs: 100,
      pollMs: 5,
      holdMs: 1_000,
    })
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

  it("takes the next request's dialog for an answer even where that request registered after the keys", async () => {
    // Codex's patch approvals come one after another, and the next one's hook runs as its
    // dialog is drawn: it is no request yet when the first is answered.
    const next: RequestFacts = { ...facts, input: { command: "pwd" } }
    let registered = false
    const { tui, answers } = terminal({
      others: () => (registered ? [{ ref: "r2", facts: next, askedAt: Date.now() }] : []),
      after: (each) => {
        // The next dialog is drawn in place of the answered one, and its request exists now.
        each.command = "pwd"
        each.state = "ask"
        registered = true
      },
    })
    await give(tui, answers, { type: "choice", option: "1" })
    expect(tui.written).toEqual(["1"])
  })

  it("takes no request asked before the keys, and unknown at the start, for the next dialog's", async () => {
    const next: RequestFacts = { ...facts, input: { command: "pwd" } }
    let registered = false
    const { tui, answers } = terminal({
      // It was asked a while ago, and only came into the list as the answer was taken.
      others: () => (registered ? [{ ref: "r2", facts: next, askedAt: 1 }] : []),
      after: (each) => {
        each.command = "pwd"
        each.state = "ask"
        registered = true
      },
    })
    expect(await fails(give(tui, answers, { type: "choice", option: "1" }))).toBe("ANSWER_FAILED")
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

describe("a request answered through a dialog taken as the agent's next prompt", () => {
  // The answer of the question, with the words given if any.
  const questions = (
    read: () => { dialog: Parameters<typeof identified>[0] } | undefined,
    text?: string,
  ) => ({
    dialog: identified(read()!.dialog)!.id,
    type: "questions" as const,
    answers: [
      {
        question: "q1",
        options: text === undefined ? ["1"] : [],
        ...(text !== undefined && { text }),
      },
    ],
  })

  it("sends the prompt once the person's keys are let go, pressing nothing, and marks it answered", async () => {
    const { tui, answers, calls, read } = terminal({ byPrompt: true })
    await answers.answer("t", "r1", questions(read))
    expect(tui.written).toEqual([])
    expect(calls).toEqual(["release", "prompt > Which?\n\nBlue", "done"])
  })

  it("fails as the prompt's refusal does, leaving the request open and its dialog unlocked", async () => {
    const { tui, answers, calls, locks, read } = terminal({
      byPrompt: true,
      refusals: [refusal("draft")],
    })
    expect(await fails(answers.answer("t", "r1", questions(read, "Purple")))).toBe("CONFLICT")
    expect(tui.written).toEqual([])
    expect(calls).not.toContain("done")
    expect(locks).toEqual([])
  })

  it("refuses it while the agent's turn runs, sending nothing", async () => {
    const { answers, calls, read } = terminal({ byPrompt: true, working: true })
    expect(await fails(answers.answer("t", "r1", questions(read)))).toBe("CONFLICT")
    expect(calls.filter((call) => call.startsWith("prompt"))).toEqual([])
  })

  it("refuses an answer it gives no prompt for, or one a prompt can't carry", async () => {
    const { answers, calls, read } = terminal({ byPrompt: true })
    expect(
      await fails(
        answers.answer("t", "r1", {
          dialog: identified(read()!.dialog)!.id,
          type: "chat",
          text: "hi",
        }),
      ),
    ).toBe("CONFLICT")
    expect(await fails(answers.answer("t", "r1", questions(read, "ask @")))).toBe("PROMPT_REFUSED")
    expect(calls.filter((call) => call.startsWith("prompt"))).toEqual([])
  })

  it("doesn't clash with another request's dialog answered as a prompt on the same screen", async () => {
    const { answers, calls, read } = terminal({
      byPrompt: true,
      others: [{ ref: "r3", facts: { ...facts, input: { command: "pwd" } } }],
    })
    await answers.answer("t", "r1", questions(read))
    expect(calls).toContain("done")
  })
})

describe("the words that follow a request's answer through its dialog", () => {
  it("are tried again while a request is still pending, which clears by itself", () =>
    timed(async () => {
      const { answers, calls, read } = terminal({
        prompting: true,
        refusals: [refusal("pending"), refusal("pending")],
      })
      await answers.answer("t", "r1", choose(read))
      expect(calls.filter((call) => call.startsWith("prompt"))).toHaveLength(3)
    }))

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

  it("are one entry of the terminal's input queue with their answer: nothing comes between", async () => {
    const { answers, queue, calls, read } = terminal({ prompting: true })
    const answered = answers.answer("t", "r1", choose(read))
    // Queued behind the answer as it begins, as a doorbell ring or a prompt would be.
    const other = queue.run("t", () => Promise.resolve(void calls.push("other entry")))
    await Promise.all([answered, other])
    expect(calls.indexOf("prompt do it differently")).toBeGreaterThan(-1)
    expect(calls.indexOf("other entry")).toBeGreaterThan(calls.indexOf("prompt do it differently"))
  })

  it("wait for the screen to settle before they go, longer while a turn runs", () =>
    timed(async () => {
      const quiet = terminal({ prompting: true })
      const began = Date.now()
      await quiet.answers.answer("t", "r1", choose(quiet.read))
      const idle = Date.now() - began
      const busy = terminal({ prompting: true, working: true })
      const started = Date.now()
      await busy.answers.answer("t", "r1", choose(busy.read))
      // A still screen settles after six reads' time (30 ms here) with no turn running, and
      // after fifteen's (75 ms) while one runs. Looks are two polls (10 ms) apart, so they
      // land at 30 and 80 ms: everything else in the two answers is the same.
      expect(Date.now() - started - idle).toBe(80 - 30)
    }))
})

describe("waiting for an agent's screen to settle before words follow an answer", () => {
  type Calm = { calm: (id: string) => Promise<void> }
  /** Answers on a screen that `drawing` changes on each look, with the default waits. */
  const settling = (options: { working?: boolean; drawing?: boolean; gone?: boolean }) => {
    const { host, queue } = terminal({ working: options.working ?? false })
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
      queue,
      {},
    )
    return (answers as unknown as Calm).calm("t")
  }

  // Each look is two polls (100 ms) apart, so a wait ends on the first look past its time.
  it("settles once a still screen has no turn running, after 0.6 s", () =>
    timed(async () => {
      const started = Date.now()
      await settling({})
      const took = Date.now() - started
      expect(took).toBeGreaterThanOrEqual(600)
      expect(took).toBeLessThan(700)
    }))

  it("settles after 1.5 s of a still screen whatever the activity says", () =>
    timed(async () => {
      const started = Date.now()
      await settling({ working: true })
      const took = Date.now() - started
      expect(took).toBeGreaterThanOrEqual(1_500)
      expect(took).toBeLessThan(1_600)
    }))

  it("gives up after 6 s on a screen that never holds still, and goes on", () =>
    timed(async () => {
      const started = Date.now()
      await settling({ drawing: true })
      const took = Date.now() - started
      expect(took).toBeGreaterThanOrEqual(6_000)
      expect(took).toBeLessThan(6_100)
    }))

  it("returns at once for a terminal that is gone", () =>
    timed(async () => {
      const started = Date.now()
      await settling({ gone: true })
      expect(Date.now() - started).toBe(0)
    }))
})
