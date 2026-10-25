import type { ActivityEvent } from "@novadeck/harness-core/events"
import { afterEach, beforeEach, vi } from "vitest"

import { apply, escapeVerdictMs, started, summary, type Activity } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import { Asks, memoryAsks, type TurnOwner } from "../messaging/asks.js"
import { describe, expect, it } from "../test.js"
import type { Record } from "./record.js"
import type { TranscriptRedactor } from "./redaction.js"
import { TurnEnds, finishGraceMs } from "./turn-ends.js"

const terminalId = "00000000-0000-4000-8000-000000000002"
const owner: TurnOwner = {
  projectId: "00000000-0000-4000-8000-000000000003",
  workspaceSessionId: "00000000-0000-4000-8000-000000000004",
  terminalId,
  handle: "h",
  agent: "claude",
  sessionId: "s",
}
const binding: Binding = { agent: "claude", sessionId: "s", instance: "7" }
const fact = (fields: object) =>
  ({ agent: "claude", sessionId: "s", instance: "7", startedAt: 5, ...fields }) as ActivityEvent
const on = (activity: Activity, fields: object) => apply(activity, binding, fact(fields))!
const begin = (activity: Activity, startedAt: number) =>
  on(activity, { type: "turn-started", cause: "prompt", startedAt })
const end = (activity: Activity, startedAt: number, extra: object = {}) =>
  on(activity, {
    type: "turn-ended",
    outcome: "completed",
    startedAt,
    reply: "All done.",
    ...extra,
  })

/** A redactor that masks `secret` and counts its calls; `null` answers fail. */
const redactor = (answer?: (text: string) => string | null | undefined) => {
  const redact = vi.fn<(input: { text: string }) => Promise<string | null | undefined>>(
    async ({ text }) => (answer ? answer(text) : text.replaceAll("hunter2", "*******")),
  )
  return { redact, close: async () => {} } as unknown as TranscriptRedactor & {
    redact: typeof redact
  }
}

const setup = (options: { redactor?: TranscriptRedactor; known?: boolean } = {}) => {
  let alive = true
  const mails = vi.fn<(terminalId: string) => void>()
  const asks = new Asks(
    {
      owner: () => owner,
      reply: () => {
        throw new Error("no reply")
      },
      replyState: () => undefined,
      forgetReplies: () => {},
      changed: mails,
      exists: () => alive,
    },
    memoryAsks(),
    Date.now,
    { sweepMs: 0 },
  )
  const ends = new TurnEnds({
    turns: () => ({ asks, redactor: options.redactor }),
    owner: () => (options.known === false ? undefined : owner),
  })
  const record = {
    summary: { id: terminalId },
    bound: { binding, activity: started(0, true, false), telemetry: null },
  } as unknown as Record
  const show = (activity: Activity, { pending = 0 }: { pending?: number } = {}) => {
    record.bound = { ...record.bound!, activity }
    const shown = summary(activity)
    ends.sight(record, {
      ...shown,
      attention: { pending, kind: pending ? "permission" : null },
    })
  }
  const turns = () =>
    asks.list().flatMap((letter) => (letter.content.kind === "turn" ? [letter] : []))
  return {
    asks,
    ends,
    record,
    show,
    turns,
    mails,
    close: () => {
      alive = false
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 10_000 })
})
afterEach(() => {
  vi.useRealTimers()
})

const settle = () => vi.advanceTimersByTimeAsync(0)
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe("storing finished turns", () => {
  it("stores a completed end after its grace, if the agent still rests", async () => {
    const run = setup()
    run.show(end(begin(run.record.bound!.activity, 1), 100))
    await wait(finishGraceMs - 1)
    expect(run.turns()).toEqual([])
    await wait(1)
    expect(run.turns()).toMatchObject([
      { at: 100, ...owner, content: { kind: "turn", outcome: "completed", reply: "All done." } },
    ])
  })

  it("stores a failed end at once, with its error", async () => {
    const run = setup()
    run.show(end(begin(run.record.bound!.activity, 1), 100, { outcome: "failed", error: "boom" }))
    await settle()
    expect(run.turns()).toMatchObject([{ content: { outcome: "failed", error: "boom" } }])
  })

  it("stores nothing while a new turn replaced the end, or the agent works", async () => {
    const run = setup()
    const ended = end(begin(run.record.bound!.activity, 1), 100)
    run.show(ended)
    run.show(begin(ended, 200))
    await wait(finishGraceMs * 2)
    expect(run.turns()).toEqual([])
  })

  it("waits for subagents, and stores the end once they are done", async () => {
    const run = setup()
    const working = on(begin(run.record.bound!.activity, 1), {
      type: "subagent-started",
      actor: "a",
      actorType: "explorer",
      startedAt: 2,
    })
    const ended = end(working, 100)
    expect(summary(ended).state).toBe("working")
    run.show(ended)
    await wait(finishGraceMs * 2)
    expect(run.turns()).toEqual([])
    // An idle status line counts them done.
    run.show({
      ...on(ended, { type: "subagent-stopped", actor: "a", startedAt: 150 }),
      background: null,
    })
    await wait(finishGraceMs)
    // The turn's end has `at` 100 still.
    expect(run.turns()).toMatchObject([{ at: 100 }])
  })

  it("stores nothing for an interrupted, unknown or limited end, a request waiting, or no owner", async () => {
    const base = (run: ReturnType<typeof setup>) => begin(run.record.bound!.activity, 1)
    const cases: [string, (run: ReturnType<typeof setup>) => void][] = [
      ["interrupted", (run) => run.show(end(base(run), 100, { outcome: "interrupted" }))],
      ["unknown", (run) => run.show(on(base(run), { type: "turn-idle", startedAt: 100 }))],
      [
        "limited",
        (run) =>
          run.show(end(base(run), 100, { outcome: "failed", error: "limit", limited: true })),
      ],
      ["a request waiting", (run) => run.show(end(base(run), 100), { pending: 1 })],
    ]
    for (const [why, work] of cases) {
      const run = setup()
      work(run)
      // eslint-disable-next-line no-await-in-loop -- Each case runs on its own clock.
      await wait(finishGraceMs * 2)
      expect(run.turns(), why).toEqual([])
    }
    const nobody = setup({ known: false })
    nobody.show(end(begin(nobody.record.bound!.activity, 1), 100))
    await wait(finishGraceMs * 2)
    expect(nobody.turns()).toEqual([])
  })

  it("stores nothing for a closed terminal", async () => {
    const run = setup()
    const ended = end(begin(run.record.bound!.activity, 1), 100)
    run.show(ended)
    run.close()
    await wait(finishGraceMs * 2)
    expect(run.turns()).toEqual([])
    run.show(end(begin(ended, 200), 300, { outcome: "failed", error: "x" }))
    await settle()
    expect(run.turns()).toEqual([])
  })
})

// The harness's own record of the interruption, within the verdict's window.
const correct = (settled: Activity) =>
  end(settled, settled.lastTurn!.escaped!.key + 100, { outcome: "interrupted", recorded: true })

describe("an Escape against an end", () => {
  // Times are epoch milliseconds: the Escape's key is now.
  const key = () => Date.now()
  const stopped = (run: ReturnType<typeof setup>) =>
    on(begin(run.record.bound!.activity, 1), { type: "turn-escaped", startedAt: key() })

  it("waits while the Escape is unsettled", async () => {
    // A harness with records holds the Stop until the window passes.
    const run = setup()
    run.record.bound = {
      ...run.record.bound!,
      activity: started(0, true, true),
    }
    const escaped = stopped(run)
    run.show(escaped)
    run.show(end(escaped, key() + 30))
    await wait(finishGraceMs * 3)
    expect(run.turns()).toEqual([])
  })

  it("stores a settled end after the verdict's window, and not if the window corrects it", async () => {
    const kept = setup()
    kept.show(end(stopped(kept), key() + 30))
    await wait(finishGraceMs)
    // Grace alone is not enough: the Escape's verdict window runs to key + escapeVerdictMs.
    expect(kept.turns()).toEqual([])
    await wait(escapeVerdictMs)
    expect(kept.turns()).toHaveLength(1)

    const corrected = setup()
    const settled = end(stopped(corrected), key() + 30)
    corrected.show(settled)
    await wait(finishGraceMs)
    corrected.show(correct(settled))
    await wait(escapeVerdictMs * 2)
    expect(corrected.turns()).toEqual([])
  })
})

describe("the same end told again", () => {
  it("updates the stored turn in place, and a no-op writes nothing", async () => {
    const run = setup()
    run.show(end(begin(run.record.bound!.activity, 1), 100, { reply: "First." }))
    await wait(finishGraceMs)
    const [first] = run.turns()
    const asks = run.asks
    const saved = vi.spyOn(asks as unknown as { save: () => void }, "save")
    // Same end, nothing new: no write.
    run.show(run.record.bound!.activity)
    await settle()
    expect(saved).not.toHaveBeenCalled()
    // A later Stop's reply (the same `at`) fills in.
    const again = on(run.record.bound!.activity, {
      type: "turn-ended",
      outcome: "completed",
      startedAt: 100,
      reply: "Second.",
    })
    run.show(again)
    await settle()
    expect(run.turns()).toMatchObject([{ id: first!.id, content: { reply: "Second." } }])
  })

  it("removes the stored turn when its end turns out limited", async () => {
    const run = setup()
    const failed = end(begin(run.record.bound!.activity, 1), 100, { outcome: "failed", error: "x" })
    run.show(failed)
    await settle()
    expect(run.turns()).toHaveLength(1)
    run.show(on(failed, { type: "turn-ended", outcome: "failed", startedAt: 100, limited: true }))
    await settle()
    expect(run.turns()).toEqual([])
    // And a read end is not stored again.
  })

  it("does not store a read end again", async () => {
    const run = setup()
    const ended = end(begin(run.record.bound!.activity, 1), 100)
    run.show(ended)
    await wait(finishGraceMs)
    run.asks.read(run.turns().map(({ id }) => id))
    run.show(
      on(ended, { type: "turn-ended", outcome: "completed", startedAt: 100, reply: "More." }),
    )
    await wait(finishGraceMs)
    expect(run.turns()).toEqual([])
  })
})

describe("an end whose session ends in its grace (B1)", () => {
  const rest = (run: ReturnType<typeof setup>) => {
    run.show(end(begin(run.record.bound!.activity, 1), 100))
    return run.record
  }

  it("is stored by the flush a binding's end, a rebind or a shell exit makes", async () => {
    // Each of these ends passes through `Bindings.unwatch`, which flushes by terminal.
    for (const why of ["endBinding", "rebind", "shell exit"]) {
      const run = setup()
      rest(run)
      // The binding is gone or replaced before the flush, as in each of the three.
      run.record.bound = why === "rebind" ? { ...run.record.bound!, activity: started(0) } : null
      run.ends.flush(terminalId)
      expect(run.turns(), why).toMatchObject([{ at: 100, content: { reply: null } }])
      // eslint-disable-next-line no-await-in-loop -- Each case runs on its own clock.
      await settle()
      expect(run.turns(), why).toMatchObject([{ at: 100, content: { reply: "All done." } }])
    }
  })

  it("stores nothing if a correction was seen first", async () => {
    const run = setup()
    const settled = end(
      on(begin(run.record.bound!.activity, 1), { type: "turn-escaped", startedAt: Date.now() }),
      Date.now() + 30,
    )
    run.show(settled)
    run.show(correct(settled))
    run.ends.flush(terminalId)
    await wait(finishGraceMs * 2)
    expect(run.turns()).toEqual([])
  })

  it("stores nothing after Asks closes, and a hook error is caught", async () => {
    const run = setup()
    rest(run)
    run.asks.close()
    run.ends.flush(terminalId)
    await wait(finishGraceMs * 2)
    expect(run.turns()).toEqual([])
    const broken = new TurnEnds({
      turns: () => {
        throw new Error("boom")
      },
      owner: () => owner,
    })
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const bound = run.record.bound
    expect(() => broken.sight(run.record, bound ? summary(bound.activity) : null)).not.toThrow()
    logged.mockRestore()
  })

  it("captures the owner when the end is seen", async () => {
    const run = setup()
    let current: TurnOwner | undefined = owner
    const ends = new TurnEnds({
      turns: () => ({ asks: run.asks, redactor: undefined }),
      owner: () => current,
    })
    const bound = end(begin(run.record.bound!.activity, 1), 100)
    run.record.bound = { ...run.record.bound!, activity: bound }
    ends.sight(run.record, summary(bound))
    current = { ...owner, sessionId: "other" }
    await wait(finishGraceMs)
    expect(run.turns()).toMatchObject([{ sessionId: "s" }])
  })
})

describe("the text of a stored turn", () => {
  it("masks a secret in the reply and the error", async () => {
    const run = setup({ redactor: redactor() })
    run.show(
      end(begin(run.record.bound!.activity, 1), 100, {
        outcome: "failed",
        reply: "password hunter2",
        error: "login with hunter2 failed",
      }),
    )
    await settle()
    expect(run.turns()[0]!.content).toMatchObject({
      reply: "password *******",
      error: "login with ******* failed",
    })
  })

  it("stores null where the redaction fails, never the text", async () => {
    const run = setup({ redactor: redactor(() => null) })
    run.show(end(begin(run.record.bound!.activity, 1), 100, { reply: "secret hunter2" }))
    await wait(finishGraceMs)
    expect(run.turns()[0]!.content).toMatchObject({ reply: null })
  })

  it("keeps the text as it is where there is no redactor", async () => {
    const run = setup()
    run.show(end(begin(run.record.bound!.activity, 1), 100, { reply: "plain" }))
    await wait(finishGraceMs)
    expect(run.turns()[0]!.content).toMatchObject({ reply: "plain" })
  })
})
