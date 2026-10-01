import { describe, expect, it } from "../test.js"
import {
  continues,
  maxContinuations,
  pendingEnter,
  route,
  submitWindowMs,
  transition,
  unbound,
  type Delivery,
  type DeliveryEvent,
  type KeyKind,
} from "./delivery.js"

const bound = transition(unbound, { type: "bound" })
const run = (from: Delivery, ...events: (DeliveryEvent | readonly DeliveryEvent[])[]): Delivery =>
  events.flat().reduce(transition, from)

const at = 1_000_000
const key = (kind: KeyKind, time = at, asked = false): DeliveryEvent => ({
  type: "key",
  key: kind,
  asked,
  at: time,
})
const prompted = (time = at + 100): DeliveryEvent => ({ type: "prompt", by: "prompt", at: time })
// The person's submission: their bare Enter, then a root prompt shortly after.
const person = [key("enter"), prompted()] as const
const harness = { type: "prompt", by: "harness", at } as const
const call = { type: "prompt", by: "call", at } as const
const stop = { type: "stop", continued: false, background: false, at } as const
const continued = { type: "stop", continued: true, background: false, at } as const
const background = { type: "stop", continued: false, background: true, at } as const
const ended = { type: "ended" } as const
const idle = { type: "idle", background: false, at } as const
const idleWithWork = { type: "idle", background: true, at } as const
const typing = key("content")
const enter = key("enter")

const working = run(bound, person)
// A Stop as the runner settles it: continued while NovaDeck still may.
const continuous = (delivery: Delivery): DeliveryEvent => (continues(delivery) ? continued : stop)
const settled = run(working, stop)
const drafting = run(settled, typing)
const unknown = run(working, ended)

describe("a terminal's delivery state", () => {
  it("is Fresh once a session binds, with its prompt known empty", () => {
    expect(bound).toMatchObject({
      state: "fresh",
      continued: 0,
      box: { empty: true, queuing: false, enteredAt: null },
    })
  })

  it("is Unbound in every bound state once the binding ends", () => {
    for (const from of [bound, working, settled, drafting, unknown])
      expect(transition(from, { type: "unbound" }).state).toBe("unbound")
  })

  it("is Fresh again in every bound state once its harness announces a new session", () => {
    for (const from of [working, settled, drafting, unknown])
      expect(transition(from, { type: "bound" })).toMatchObject({
        state: "fresh",
        continued: 0,
        box: { empty: true },
      })
  })

  it("works from Fresh, Settled, Drafting and Unknown once a root prompt starts a turn", () => {
    for (const from of [bound, settled, drafting, unknown])
      expect(run(from, person)).toMatchObject({
        state: "working",
        phase: "turn",
        continued: 0,
        epoch: from.epoch + 1,
      })
  })

  it("settles at a normal root Stop not continued, the prompt known empty, since then", () => {
    expect(settled).toMatchObject({
      state: "settled",
      since: at,
      continued: 0,
      box: { empty: true },
    })
  })

  it("leaves the person drafting at a Stop when the prompt isn't known empty", () => {
    expect(run(working, typing, stop).state).toBe("drafting")
    // A turn the harness started by itself proves nothing about the prompt.
    expect(run(drafting, harness, stop).state).toBe("drafting")
  })

  it("leaves the person drafting at a Stop once they submitted during the turn", () => {
    const queued = run(working, enter)
    expect(queued).toMatchObject({ state: "working", box: { queuing: true } })
    expect(continues(queued)).toBe(false)
    expect(transition(queued, stop).state).toBe("drafting")
  })

  it("keeps working through a Stop NovaDeck continued, counting it, up to its limit", () => {
    const once = transition(working, continued)
    expect(once).toMatchObject({ state: "working", phase: "continuing", continued: 1 })
    expect(continues(once)).toBe(true)
    const limit = run(working, ...Array.from({ length: maxContinuations }, () => continued))
    expect(continues(limit)).toBe(false)
    // Its continuation, even from the turn's first model call again, is the same turn.
    expect(run(limit, harness, call).continued).toBe(maxContinuations)
    expect(run(limit, harness).epoch).toBe(working.epoch)
    expect(transition(limit, stop).state).toBe("settled")
  })

  it("keeps working while what the turn started still runs, until it ends", () => {
    const waiting = transition(working, background)
    expect(waiting).toMatchObject({ state: "working", phase: "background", continued: 0 })
    // A background task's result starts a turn by itself, whose Stop ends it.
    expect(run(waiting, harness, stop).state).toBe("settled")
    // Antigravity's subagents finishing, as its idle status line says, ends it too.
    expect(transition(waiting, idleWithWork)).toEqual(waiting)
    expect(transition(waiting, { ...idle, at: at + 5 })).toMatchObject({
      state: "settled",
      since: at + 5,
    })
  })

  it("takes the person's Enter while only background work runs as a prompt, not one queued", () => {
    const waiting = run(working, continued, background)
    const submitted = transition(waiting, enter)
    expect(submitted).toMatchObject({ state: "working", box: { queuing: false } })
    // Their prompt starts a new turn, with nothing queued and no continuations yet.
    const turn = transition(submitted, prompted())
    expect(turn).toMatchObject({ phase: "turn", continued: 0, box: { queuing: false } })
    expect(turn.epoch).toBe(waiting.epoch + 1)
    expect(continues(turn)).toBe(true)
  })

  it("starts a new turn's count at the person's prompt after a turn that never stopped", () => {
    // As after a failed Codex turn, which sends nothing: the person's Enter, then prompt.
    const failed = run(working, continued, harness, call)
    const next = run(failed, person)
    expect(next).toMatchObject({ continued: 0, box: { queuing: false } })
    expect(continues(next)).toBe(true)
  })

  it("is Unknown after an abnormal end, keeping the turn's counts for a Stop that raced it", () => {
    expect(unknown).toMatchObject({ state: "unknown" })
    const queued = run(working, continued, call, enter, ended)
    expect(queued).toMatchObject({ continued: 1, box: { queuing: true } })
    expect(continues(queued)).toBe(false)
    expect(transition(unknown, stop).state).toBe("settled")
  })

  it("takes an idle status line before the turn's Stop as an end, without losing its counts", () => {
    const limit = run(working, continued, harness, continued, harness)
    const idled = transition(limit, idle)
    expect(idled).toMatchObject({ state: "unknown", continued: maxContinuations })
    // The Stop that follows is still that turn's: it may not be continued again.
    expect(continues(idled)).toBe(false)
    expect(transition(idled, stop).state).toBe("settled")
  })

  it("keeps a continued Stop's count when the status line says working before its continuation", () => {
    // As Antigravity's status line, which reports working as the continuation begins.
    let delivery = working
    for (let index = 0; index < 5; index += 1) {
      delivery = run(delivery, continuous(delivery), call, harness, call)
    }
    expect(delivery.continued).toBe(maxContinuations)
    expect(continues(delivery)).toBe(false)
    expect(run(working, continued, call)).toMatchObject({ phase: "continuing", continued: 1 })
    expect(run(working, continued, call, harness)).toMatchObject({ phase: "turn", continued: 1 })
  })

  it("takes an idle status line after the turn's Stop as nothing new", () => {
    const stopped = transition(working, continued)
    expect(transition(stopped, idle)).toEqual(stopped)
    // Its continuation then runs on with its count.
    expect(run(stopped, idle, harness)).toMatchObject({ state: "working", continued: 1 })
    expect(transition(settled, idle)).toEqual(settled)
  })

  it("leaves Settled for Drafting at the person's input, but not at keys while asked", () => {
    expect(drafting).toMatchObject({ state: "drafting", box: { empty: false } })
    expect(transition(settled, key("enter", at, true))).toEqual(settled)
    // An Enter answering a request during the turn is no submission either.
    expect(run(working, key("enter", at, true), stop).state).toBe("settled")
  })

  it("makes the prompt known empty again at the person's own prompt only", () => {
    expect(run(drafting, person).box.empty).toBe(true)
    expect(run(drafting, enter, harness).box.empty).toBe(false)
    expect(run(drafting, enter, call).box.empty).toBe(false)
  })

  it("ignores everything but a binding while Unbound", () => {
    for (const event of [prompted(), stop, ended, enter, idle])
      expect(transition(unbound, event)).toBe(unbound)
  })

  it("ignores a Stop with no turn to end", () => {
    expect(transition(settled, stop)).toEqual(settled)
    expect(transition(drafting, continued)).toEqual(drafting)
  })
})

describe("the person's submission", () => {
  it("is a prompt shortly after their bare Enter, with nothing typed since", () => {
    expect(run(drafting, key("enter"), prompted(at + submitWindowMs), stop).state).toBe("settled")
    // Too late: not the Enter's.
    expect(run(drafting, key("enter"), prompted(at + submitWindowMs + 1), stop).state).toBe(
      "drafting",
    )
    // Typed after the Enter: that stays in the box.
    expect(run(drafting, key("enter"), key("content"), prompted(), stop).state).toBe("drafting")
    // A queue key counts as the Enter does.
    expect(run(drafting, key("queue"), prompted(), stop).state).toBe("settled")
  })

  it("is never a turn the harness started, which leaves the Enter for its own prompt", () => {
    const after = run(drafting, key("enter"), harness)
    expect(after.box).toMatchObject({ empty: false, enteredAt: at })
    expect(run(after, stop, prompted(), stop).state).toBe("settled")
  })

  it("is a prompt queued during the turn, the next one after its Stop, if nothing was typed after", () => {
    const queuedTurn = run(working, typing, enter, stop)
    expect(queuedTurn).toMatchObject({ state: "drafting", box: { queued: true } })
    expect(run(queuedTurn, prompted(at + 60_000), stop).state).toBe("settled")
    const typedAfter = run(working, typing, enter, typing, stop)
    expect(typedAfter.box.queued).toBe(false)
    expect(run(typedAfter, prompted(at + 60_000), stop).state).toBe("drafting")
  })
})

describe("keys while a request waits on the person", () => {
  const asked = (kind: KeyKind) => key(kind, at, true)

  it("are never a submission, and leave a content key's draft for when it clears", () => {
    const answering = run(working, asked("content"), asked("enter"))
    expect(answering.box).toMatchObject({ draftWhileAsked: true, queuing: false })
    expect(continues(answering)).toBe(true)
    expect(run(answering, { type: "asked-cleared" }, stop).state).toBe("drafting")
  })

  it("leave the box as it was when only Enter and neutral keys answered", () => {
    expect(
      run(working, asked("neutral"), asked("enter"), { type: "asked-cleared" }, stop).state,
    ).toBe("settled")
  })

  it("keep their draft until a confirmed submission undoes it", () => {
    const answering = run(working, asked("content"))
    expect(run(answering, person, { type: "asked-cleared" }, stop).state).toBe("settled")
  })
})

describe("when a message would reach an agent", () => {
  it("says so in send's words for each state", () => {
    expect(route(bound, false)).toBe("when its agent first prompts")
    expect(route(working, false)).toBe("when its current turn ends")
    // Codex sends nothing when a turn fails.
    expect(route(working, true)).toBe("at its turn's end or its next prompt")
    expect(route(transition(working, background), false)).toBe("when its next turn starts")
    expect(route(settled, false)).toBe("ringing it now")
    for (const state of [drafting, unknown])
      expect(route(state, false)).toBe("when the person next submits a prompt there")
  })
})

describe("a ring", () => {
  const ringing = transition(settled, { type: "ring", nonce: "k3f9" })
  const doorbell = { type: "prompt", by: "doorbell", nonce: "k3f9", at } as const

  it("rings only a Settled terminal, its line a draft until its own prompt", () => {
    expect(ringing).toMatchObject({
      state: "ringing",
      nonce: "k3f9",
      touched: false,
      epoch: settled.epoch,
      box: { empty: false },
    })
    for (const from of [bound, working, drafting, unknown, unbound])
      expect(transition(from, { type: "ring", nonce: "k3f9" })).toBe(from)
  })

  it("is confirmed by its own doorbell prompt: a new turn, the prompt empty", () => {
    expect(transition(ringing, doorbell)).toMatchObject({
      state: "working",
      phase: "turn",
      epoch: settled.epoch + 1,
      continued: 0,
      box: { empty: true },
    })
    // The person typed while it rang: what they typed waits in the box.
    expect(run(ringing, typing)).toMatchObject({ state: "ringing", touched: true })
    expect(run(ringing, typing, doorbell)).toMatchObject({
      state: "working",
      box: { empty: false },
    })
  })

  it("is not confirmed by another nonce's doorbell prompt", () => {
    expect(transition(ringing, { ...doorbell, nonce: "old" })).toMatchObject({
      state: "working",
      box: { empty: false },
    })
  })

  it("fails into Unknown only for its own nonce, its line taken as a draft", () => {
    expect(transition(ringing, { type: "ring-failed", nonce: "k3f9" })).toMatchObject({
      state: "unknown",
      box: { empty: false },
    })
    expect(transition(ringing, { type: "ring-failed", nonce: "other" })).toBe(ringing)
    expect(transition(settled, { type: "ring-failed", nonce: "k3f9" })).toBe(settled)
  })

  it("gives way to any other root prompt, an abnormal end, or the binding ending", () => {
    // Its line may be left in the box: a draft, whoever started the turn.
    for (const event of [person, [harness], [call]])
      expect(run(ringing, event)).toMatchObject({
        state: "working",
        phase: "turn",
        box: { empty: false },
      })
    expect(transition(ringing, ended)).toMatchObject({ state: "unknown", box: { empty: false } })
    expect(transition(ringing, { type: "unbound" }).state).toBe("unbound")
    expect(transition(ringing, { type: "bound" }).state).toBe("fresh")
    // No Stop or idle status line ends it.
    for (const event of [stop, idle]) expect(transition(ringing, event)).toBe(ringing)
  })

  it("outside a ring, proves nothing of the box but what the person did", () => {
    // An agent started with the line, nothing typed since it bound: the box stays empty.
    expect(transition(bound, doorbell)).toMatchObject({ state: "working", box: { empty: true } })
    // The person typed before the start's first hook: their draft stays.
    expect(run(bound, typing, doorbell)).toMatchObject({ state: "working", box: { empty: false } })
    // A late hook of a failed ring, after the person typed: their draft stays.
    const failed = run(ringing, { type: "ring-failed", nonce: "k3f9" }, typing)
    expect(transition(failed, doorbell)).toMatchObject({ state: "working", box: { empty: false } })
    expect(run(failed, doorbell, stop).state).toBe("drafting")
    // Their own bare Enter submitted a stale line: that Enter may have left text in the
    // box (a newline, a suggestion), so the draft stays, and the Enter is spent.
    expect(run(drafting, key("enter"), { ...doorbell, at: at + 100 })).toMatchObject({
      box: { empty: false, enteredAt: null },
    })
  })
})

describe("the person's Enter window", () => {
  it("is open for a while after a bare Enter, closed once they typed again", () => {
    const entered = run(drafting, key("enter"))
    expect(pendingEnter(entered, at + submitWindowMs)).toBe(at)
    expect(pendingEnter(entered, at + submitWindowMs + 1)).toBeUndefined()
    expect(pendingEnter(run(entered, typing), at + 1)).toBeUndefined()
    expect(pendingEnter(drafting, at)).toBeUndefined()
  })
})
