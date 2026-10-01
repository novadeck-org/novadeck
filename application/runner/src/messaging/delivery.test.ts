import { describe, expect, it } from "../test.js"
import {
  continues,
  maxContinuations,
  route,
  transition,
  unbound,
  type Delivery,
  type DeliveryEvent,
} from "./delivery.js"

const bound = transition(unbound, { type: "bound" })
const run = (from: Delivery, ...events: DeliveryEvent[]): Delivery =>
  events.reduce(transition, from)

const person = { type: "prompt", by: "person" } as const
const harness = { type: "prompt", by: "harness" } as const
const call = { type: "prompt", by: "call" } as const
const stop = { type: "stop", continued: false, background: false } as const
const continued = { type: "stop", continued: true, background: false } as const
const background = { type: "stop", continued: false, background: true } as const
const ended = { type: "ended" } as const
const idle = { type: "idle", background: false } as const
const idleWithWork = { type: "idle", background: true } as const
const typing = { type: "input", submits: false, answers: false } as const
const enter = { type: "input", submits: true, answers: false } as const
const answer = { type: "input", submits: true, answers: true } as const

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
      empty: true,
      submitted: false,
      continued: 0,
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
        empty: true,
        continued: 0,
      })
  })

  it("works from Fresh, Settled, Drafting and Unknown once a root prompt starts a turn", () => {
    for (const from of [bound, settled, drafting, unknown])
      expect(transition(from, person)).toMatchObject({
        state: "working",
        phase: "turn",
        continued: 0,
        epoch: from.epoch + 1,
      })
  })

  it("settles at a normal root Stop not continued, the prompt known empty", () => {
    expect(settled).toMatchObject({ state: "settled", empty: true, continued: 0 })
  })

  it("leaves the person drafting at a Stop when the prompt isn't known empty", () => {
    expect(run(working, typing, stop).state).toBe("drafting")
    // A turn the harness started by itself proves nothing about the prompt.
    expect(run(drafting, harness, stop).state).toBe("drafting")
  })

  it("leaves the person drafting at a Stop once they submitted during the turn", () => {
    const queued = run(working, enter)
    expect(queued).toMatchObject({ state: "working", submitted: true })
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
    expect(transition(waiting, idle).state).toBe("settled")
  })

  it("takes the person's Enter while only background work runs as a prompt, not one queued", () => {
    const waiting = run(working, continued, background)
    const submitted = transition(waiting, enter)
    expect(submitted).toMatchObject({ state: "working", submitted: false })
    // Their prompt starts a new turn, with nothing queued and no continuations yet.
    const turn = transition(submitted, person)
    expect(turn).toMatchObject({ phase: "turn", submitted: false, continued: 0 })
    expect(turn.epoch).toBe(waiting.epoch + 1)
    expect(continues(turn)).toBe(true)
  })

  it("starts a new turn's count at the person's prompt after a turn that never stopped", () => {
    // As after a failed Codex turn, which sends nothing: the person's Enter, then prompt.
    const failed = run(working, continued, harness, call)
    const next = run(failed, enter, person)
    expect(next).toMatchObject({ submitted: false, continued: 0 })
    expect(continues(next)).toBe(true)
  })

  it("is Unknown after an abnormal end, keeping the turn's counts for a Stop that raced it", () => {
    expect(unknown).toMatchObject({ state: "unknown" })
    const queued = run(working, continued, call, enter, ended)
    expect(queued).toMatchObject({ continued: 1, submitted: true })
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

  it("leaves Settled for Drafting at the person's input, but not at an answer", () => {
    expect(drafting).toMatchObject({ state: "drafting", empty: false })
    expect(transition(settled, answer)).toEqual(settled)
    // An answer to a request during the turn is no submission either.
    expect(run(working, answer, stop).state).toBe("settled")
  })

  it("makes the prompt known empty again at the person's own prompt only", () => {
    expect(run(drafting, person).empty).toBe(true)
    expect(run(drafting, harness).empty).toBe(false)
    expect(run(drafting, call).empty).toBe(false)
  })

  it("ignores everything but a binding while Unbound", () => {
    for (const event of [person, stop, ended, enter, idle])
      expect(transition(unbound, event)).toBe(unbound)
  })

  it("ignores a Stop with no turn to end", () => {
    expect(transition(settled, stop)).toEqual(settled)
    expect(transition(drafting, continued)).toEqual(drafting)
  })
})

describe("when a message would reach an agent", () => {
  it("says so in send's words for each state", () => {
    expect(route(bound, false)).toBe("when its agent first prompts")
    expect(route(working, false)).toBe("when its current turn ends")
    // Codex sends nothing when a turn fails.
    expect(route(working, true)).toBe("at its turn's end or its next prompt")
    expect(route(transition(working, background), false)).toBe("when its next turn starts")
    for (const state of [settled, drafting, unknown])
      expect(route(state, false)).toBe("when the person next submits a prompt there")
  })
})
