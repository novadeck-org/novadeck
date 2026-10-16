import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it } from "../test.js"
import {
  queueBarLeft,
  queueBarMs,
  continues,
  midTurnCall,
  maxContinuations,
  pendingEnter,
  ringableSince,
  route,
  submitWindowMs,
  transition,
  unbound,
  type Delivery,
  type DeliveryEvent,
  type KeyKind,
} from "./delivery.js"

const run = (from: Delivery, ...events: (DeliveryEvent | readonly DeliveryEvent[])[]): Delivery =>
  events.flat().reduce((delivery, event) => transition(delivery, event), from)

const at = 1_000_000
// A session binds with nothing showing its prompt is up, or one its harness announced at
// its own input prompt, as Claude Code's SessionStart at a startup or a /clear.
const binds = { type: "bound", ready: false, at } as const
const announced = { type: "bound", ready: true, at } as const
const bound = transition(unbound, binds)
const key = (kind: KeyKind, time = at, asked = false): DeliveryEvent => ({
  type: "key",
  key: kind,
  asked,
  at: time,
})
// A root turn's start, heard at `time`, its hook started then unless it says when.
const prompted = (
  time = at + 100,
  startedAt = time,
): Extract<DeliveryEvent, { type: "prompt" }> => ({
  type: "prompt",
  by: "prompt",
  at: time,
  startedAt,
})
// The person's submission: their bare Enter, then a root prompt shortly after.
const person = [key("enter"), prompted()] as const
const harness = { type: "prompt", by: "harness", at, startedAt: at } as const
const call = { type: "prompt", by: "call", at, startedAt: at } as const
const stop = { type: "stop", continued: false, background: false, at } as const
const continued = { type: "stop", continued: true, background: false, at } as const
const background = { type: "stop", continued: false, background: true, at } as const
const ended = { type: "ended" } as const
// Antigravity's status line, its hook started at `at`: idle, or working a little later.
const idle = { type: "idle", background: false, at, startedAt: at } as const
const idleWithWork = { type: "idle", background: true, at, startedAt: at } as const
const shownWorking = { type: "working", startedAt: at + 10 } as const
const typing = key("content")
const enter = key("enter")

const working = run(bound, person)
// A Stop as the runner settles it: continued while Novadeck still may.
const continuous = (delivery: Delivery): DeliveryEvent => (continues(delivery) ? continued : stop)
const settled = run(working, stop)
const drafting = run(settled, typing)
const unknown = run(working, ended)

describe("a terminal's delivery state", () => {
  it("keeps neutral keys from changing a draft the person typed, or pending submissions", () => {
    // No session, or a draft of the person's own, where the caret moves.
    for (const from of [unbound, drafting, run(working, typing), run(settled, enter, typing)])
      expect(transition(from, key("neutral"))).toBe(from)
    // A key after the person's Enter, before its hook, keeps the prompt theirs.
    expect(run(settled, enter, key("neutral"), prompted()).byPerson).toBe(true)
  })

  it("takes Left, Home or End on a box known empty as the person's input, as only the harness's own view can take it", () => {
    // Claude Code 2.1.287's Left at an empty prompt opens its agents view, whose field a
    // ring's line would land in and its Enter start a new session with.
    const ready = transition(unbound, announced)
    expect(transition(ready, key("neutral")).state).toBe("drafting")
    expect(transition(settled, key("neutral")).state).toBe("drafting")
    expect(ringableSince(transition(settled, key("neutral")))).toBeUndefined()
    // During a turn too, its Stop then leaves a draft.
    expect(run(working, key("neutral"), stop).state).toBe("drafting")
    expect(run(bound, key("neutral"), harness, stop).state).toBe("drafting")
    // In a request's dialog, a draft once it clears (see the stale request's case below).
    expect(run(working, key("neutral", at, true), { type: "asked-cleared" }, stop).state).toBe(
      "drafting",
    )
    // Escape stays neutral: what Esc-Esc opens, the ring's test paste is left to judge.
    expect(transition(settled, key("escape"))).toBe(settled)
  })

  it("is Drafting after Right or Tab, which may take a prompt suggestion into the box", () => {
    const ready = transition(unbound, announced)
    expect(transition(ready, key("accept")).state).toBe("drafting")
    expect(transition(settled, key("accept")).state).toBe("drafting")
    expect(run(working, key("accept"), stop).state).toBe("drafting")
    // In a request's dialog, a draft once it clears, as the dialog may be gone.
    expect(run(settled, key("accept", at, true), { type: "asked-cleared" }).state).toBe("drafting")
  })

  it("takes Left, Home or End as input wherever the harness's box may be empty, the person's prompt still theirs", () => {
    // Mid-ring, held until after the doorbell's Enter emptied the box: the ring's prompt
    // leaves a draft.
    const ringing = transition(settled, { type: "ring", nonce: "k3f9", opening: false })
    expect(transition(ringing, key("neutral"))).toMatchObject({ state: "ringing", touched: true })
    const rung = run(
      ringing,
      key("neutral"),
      { type: "prompt", by: "doorbell", nonce: "k3f9", at, startedAt: at },
      stop,
    )
    expect(rung.state).toBe("drafting")
    // After the person's Enter, before its hook: their prompt, but its Stop leaves a draft.
    const entered = run(settled, enter, key("neutral"), prompted())
    expect(entered).toMatchObject({ byPerson: true, box: { empty: false } })
    expect(transition(entered, stop).state).toBe("drafting")
    // After a prompt queued mid-turn: the next prompt is still theirs, and leaves a draft.
    const queued = run(working, typing, key("enter", at + 200), key("neutral", at + 300), stop)
    expect(queued).toMatchObject({ state: "drafting", box: { queued: true } })
    const next = run(queued, prompted(at + 400))
    expect(next.byPerson).toBe(true)
    expect(transition(next, stop).state).toBe("drafting")
    // Without one, the person's next submission empties the box again.
    expect(run(settled, enter, prompted(), stop).state).toBe("settled")
  })

  it("lets a stray Left after an Enter that started no prompt cost no later submission", () => {
    // The Enter's window long gone, the key is input as anywhere else, and the person's next
    // submission empties the box again.
    const stale = run(settled, enter, key("neutral", at + submitWindowMs + 3_000))
    expect(stale.state).toBe("drafting")
    const next = run(
      stale,
      key("enter", at + submitWindowMs + 4_000),
      prompted(at + submitWindowMs + 4_100),
    )
    expect(next.byPerson).toBe(true)
    expect(transition(next, stop).state).toBe("settled")
  })

  it("forgets a stray key once the agent it strayed in has gone and another starts", () => {
    // The Left's view went with its agent: the Enter that starts the next one clears it.
    const gone = run(settled, enter, key("neutral"), { type: "unbound" })
    expect(run(gone, key("enter", at + 5_000), announced).state).toBe("ready")
  })

  it("leaves a draft for Left, Home or End while a stale request waits, its dialog gone", () => {
    // A request answered with no report: the key lands at the prompt, as Claude Code's
    // Left opens its agents view there, and the request clears later.
    const left = run(settled, key("neutral", at, true))
    expect(left.box.draftWhileAsked).toBe(true)
    expect(transition(left, { type: "asked-cleared" }).state).toBe("drafting")
  })

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
    for (const from of [working, settled, run(drafting, enter), unknown])
      expect(transition(from, binds)).toMatchObject({
        state: "fresh",
        continued: 0,
        box: { empty: true },
      })
    // What the person typed after their last Enter stays in the box.
    expect(transition(drafting, binds)).toMatchObject({ state: "fresh", box: { empty: false } })
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
    const queued = run(working, typing, enter)
    expect(queued).toMatchObject({ state: "working", box: { queuing: true } })
    expect(continues(queued)).toBe(false)
    expect(transition(queued, stop).state).toBe("drafting")
  })

  it("is Unknown at the person's Escape during a root turn, its box a draft, which a Stop ends", () => {
    // Escape before Claude Code's first reply cancels the turn, puts the prompt back in its
    // box, and no hook says so.
    const escaped = transition(working, key("escape"))
    expect(escaped).toMatchObject({
      state: "unknown",
      box: { empty: false, queuing: false },
      epoch: working.epoch,
    })
    expect(ringableSince(escaped)).toBeUndefined()
    // An Escape that ended nothing (a menu closed): the turn's Stop, which may still be
    // continued, leaves a draft, a missed ring at worst.
    expect(continues(escaped)).toBe(true)
    expect(transition(escaped, stop).state).toBe("drafting")
    // Its counts and box stay: a queued prompt, or a draft, still counts.
    const queued = run(working, typing, enter, key("escape"))
    expect(queued).toMatchObject({ state: "unknown", box: { queuing: true } })
    expect(transition(queued, stop).state).toBe("drafting")
    // Continuing, or answering a request, it ends the turn too.
    expect(run(working, continued, key("escape")).state).toBe("unknown")
    expect(transition(working, key("escape", at, true)).state).toBe("unknown")
  })

  it("starts the person's prompt as Unknown when their Escape came after its hook started", () => {
    // Enter, then Escape while the hook boots: heard after it, the turn Claude cancelled.
    const cancelled = run(
      settled,
      typing,
      enter,
      key("escape", at + 600),
      prompted(at + 1_500, at + 300),
    )
    expect(cancelled).toMatchObject({
      state: "unknown",
      epoch: settled.epoch + 1,
      box: { empty: false },
    })
    expect(transition(cancelled, stop).state).toBe("drafting")
    // An Escape before the hook started, or before the Enter, touched no such turn.
    expect(
      run(settled, typing, enter, key("escape", at + 50), prompted(at + 1_500, at + 300)).state,
    ).toBe("working")
    expect(
      run(settled, key("escape", at - 10), typing, enter, prompted(at + 1_500, at + 300)).state,
    ).toBe("working")
    // Nor one the harness started.
    expect(
      run(settled, typing, enter, key("escape", at + 600), { ...harness, startedAt: at + 300 })
        .state,
    ).toBe("working")
  })

  it("keeps a prompt the person queued after an Escape that only closed a popup", () => {
    // Escape closed a menu while the person typed; the turn ran on, and Enter queued it.
    const queued = run(working, typing, key("escape"), enter)
    expect(queued).toMatchObject({ state: "unknown", box: { queuing: true } })
    expect(continues(queued)).toBe(false)
    const after = transition(queued, stop)
    expect(after).toMatchObject({ state: "drafting", box: { queued: true } })
    // Its harness then submits the prompt they queued: theirs.
    expect(run(after, prompted(at + 60_000), stop).state).toBe("settled")
  })

  it("takes the person's prompt after an Escape that interrupted the turn as theirs", () => {
    const interrupted = transition(working, key("escape"))
    const next = run(interrupted, typing, enter, prompted(at + 100, at + 50))
    expect(next).toMatchObject({ state: "working", byPerson: true, box: { empty: true } })
    expect(transition(next, stop).state).toBe("settled")
  })

  it("takes Escape as changing nothing while no root turn runs", () => {
    const ready = transition(unbound, announced)
    const ringing = transition(ready, { type: "ring", nonce: "k3f9", opening: false })
    const waiting = transition(working, background)
    for (const from of [unbound, bound, ready, settled, drafting, unknown, ringing, waiting])
      expect(transition(from, key("escape"))).toBe(from)
  })

  it("takes a bare Enter on an empty box during a turn as neutral, as it queues nothing", () => {
    // No harness queues or steers an empty prompt mid-turn: it answered something unseen,
    // as a confirmation Antigravity's status line missed, or did nothing.
    expect(transition(working, enter)).toBe(working)
    expect(run(working, enter, stop).state).toBe("settled")
    const continuing = transition(working, continued)
    expect(transition(continuing, enter)).toBe(continuing)
    expect(continues(run(continuing, harness, enter))).toBe(true)
    // With something typed first, it queues that prompt.
    expect(run(working, typing, enter)).toMatchObject({ box: { queuing: true } })
    // Accepted gap: Down (content) on an unseen confirmation, then Enter, leaves a draft.
    expect(run(working, key("content"), enter, stop).state).toBe("drafting")
    // At its prompt, Enter keeps its meaning: it may take a suggestion.
    expect(transition(settled, enter).state).toBe("drafting")
    expect(transition(transition(unbound, announced), enter).state).toBe("drafting")
    // Only background work running, it submits a prompt at once.
    expect(run(working, background, enter).box.enteredAt).toBe(at)
  })

  it("keeps working through a Stop Novadeck continued, counting it, up to its limit", () => {
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
    // Antigravity's subagents finishing, as its idle status line says, ends it too, a
    // command it backgrounded left to run.
    expect(transition(waiting, idleWithWork)).toEqual(waiting)
    expect(transition(waiting, { ...idle, at: at + 5 })).toMatchObject({
      state: "settled",
      since: at + 5,
    })
  })

  it("ends a turn its records told ended only while that turn still runs or continues", () => {
    // A recorded end comes only where the agent's activity took it as the turn's.
    const recorded = { ...stop, recorded: true } as const
    expect(transition(working, recorded).state).toBe("settled")
    expect(transition(working, { ...recorded, background: true })).toMatchObject({
      state: "working",
      phase: "background",
    })
    expect(transition(working, { ...ended, recorded: true }).state).toBe("unknown")
    // A continuation whose own Stop's hook never reported ends at its record too.
    expect(transition(transition(working, continued), recorded).state).toBe("settled")
    // Never one already over, or waiting on its background work.
    for (const from of [settled, unknown, transition(working, background)]) {
      expect(transition(from, recorded)).toEqual(from)
      expect(transition(from, { ...ended, recorded: true })).toEqual(from)
    }
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
    const queued = run(working, continued, call, typing, enter, ended)
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

  it("keeps a continued Stop's count when a later model call comes before its continuation", () => {
    // As Antigravity's PreInvocation past a turn's first, arriving late.
    let delivery = working
    for (let index = 0; index < 5; index += 1) {
      delivery = run(delivery, continuous(delivery), call, harness, call)
    }
    expect(delivery.continued).toBe(maxContinuations)
    expect(continues(delivery)).toBe(false)
    expect(run(working, continued, call)).toMatchObject({ phase: "continuing", continued: 1 })
    expect(run(working, continued, call, harness)).toMatchObject({ phase: "turn", continued: 1 })
  })

  it("takes a call after the continued Stop's hook started as the continuation running", () => {
    // As Antigravity's continuation, whose model calls may go on past its first: an idle
    // status line after it then ends it, as one ends any turn its Stop never reported.
    const continuing = transition(working, { ...continued, startedAt: at + 10 })
    expect(transition(continuing, call)).toEqual(continuing)
    const resumed = transition(continuing, { ...call, startedAt: at + 20 })
    expect(resumed).toMatchObject({ phase: "turn", turnAt: at + 20, continued: 1 })
    expect(transition(resumed, { ...idle, startedAt: at + 30 }).state).toBe("unknown")
  })

  it("resumes a turn an idle status line ended when a newer one says working", () => {
    const resumed = run(working, continued, harness, idle, shownWorking)
    // The idle was stale: the same turn goes on, with its count.
    expect(resumed).toMatchObject({ state: "working", phase: "turn", continued: 1 })
    expect(resumed.epoch).toBe(working.epoch)
    expect(transition(resumed, stop).state).toBe("settled")
    // One whose hook started before the idle's says nothing new.
    const idled = transition(working, idle)
    expect(transition(idled, { ...shownWorking, startedAt: at })).toEqual(idled)
    expect(transition(idled, { ...shownWorking, startedAt: at - 10 })).toEqual(idled)
  })

  it("takes an idle status line whose hook started before the turn's latest start as stale", () => {
    // Drawn before the turn's first model call, or before a later one of the same turn.
    const begun = transition(bound, { ...harness, startedAt: at + 20 })
    expect(transition(begun, idle)).toEqual(begun)
    // The person's turn here started at `at + 100`.
    const called = transition(working, { ...call, startedAt: at + 120 })
    expect(transition(called, { ...idle, startedAt: at + 110 })).toEqual(called)
    expect(called.epoch).toBe(working.epoch)
    // One whose hook started after it ends the turn.
    expect(transition(begun, { ...idle, startedAt: at + 30 })).toMatchObject({ state: "unknown" })
    // A working that resumed the turn keeps the fence at the idle it followed.
    const resumed = run(
      working,
      { ...idle, startedAt: at + 105 },
      { ...shownWorking, startedAt: at + 110 },
    )
    expect(resumed).toMatchObject({ state: "working", phase: "turn" })
    expect(transition(resumed, { ...idle, startedAt: at + 104 })).toEqual(resumed)
    expect(transition(resumed, { ...idle, startedAt: at + 106 })).toMatchObject({
      state: "unknown",
    })
  })

  it("never resumes a turn a Stop ended when the status line says working", () => {
    // As Antigravity's status line, still saying working just after its Stop.
    expect(transition(settled, shownWorking)).toEqual(settled)
    expect(transition(working, shownWorking)).toEqual(working)
    const waiting = transition(working, background)
    expect(transition(waiting, shownWorking)).toEqual(waiting)
    // A failed Stop leaves it Unknown, which working does not resume either.
    expect(transition(unknown, shownWorking)).toEqual(unknown)
    const ready = transition(unbound, announced)
    const ringing = transition(ready, { type: "ring", nonce: "k3f9", opening: false })
    expect(transition(ready, shownWorking)).toEqual(ready)
    expect(transition(ringing, shownWorking)).toEqual(ringing)
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

  it("ignores everything but a binding, and the person's keys, while Unbound", () => {
    for (const event of [
      prompted(),
      stop,
      ended,
      idle,
      { type: "ring", nonce: "k3f9", opening: false } as const,
    ])
      expect(transition(unbound, event)).toBe(unbound)
    expect(run(unbound, typing)).toMatchObject({ state: "unbound", box: { empty: false } })
  })

  it("ignores a Stop with no turn to end", () => {
    expect(transition(settled, stop)).toEqual(settled)
    expect(transition(drafting, continued)).toEqual(drafting)
  })
})

describe("the person's submission", () => {
  it.for(["claude", "codex"] as const)(
    "keeps the next submitted prompt when an older %s hook arrives after its Enter",
    (agent) => {
      // Windows CI artifacts 12030729320 / 12031880182: both prompts reached the
      // model, but the first late hook spent the second prompt's later Enter.
      const first = agent === "claude" ? 2551 : 2365
      const typed = agent === "claude" ? 2602 : 2964
      const entered = agent === "claude" ? 2710 : 3128
      const fired = agent === "claude" ? 2616 : 3001
      const heard = agent === "claude" ? 3041 : 3410
      let delivery = run(
        unbound,
        { ...announced, at },
        key("content", at + first - 100),
        key("enter", at + first),
      )
      if (agent === "codex") delivery = transition(delivery, { ...binds, at: at + 2941.7754 })
      delivery = run(delivery, key("content", at + typed), key("enter", at + entered))
      delivery = transition(
        delivery,
        {
          ...prompted(at + heard, at + heard - 3),
          firedAt: at + fired,
        },
        10_000,
      )
      expect(delivery.box.enteredAt).toBe(at + entered)
      if (agent === "claude") delivery = transition(delivery, { ...stop, at: at + 3607 })
      delivery = transition(
        delivery,
        {
          ...prompted(at + 4085, at + 4082.6985),
          firedAt: at + 3695,
        },
        10_000,
      )
      expect(delivery).toMatchObject({ byPerson: true, box: { empty: true, queuing: false } })
      expect(transition(delivery, { ...stop, at: at + 4596 }).state).toBe("settled")
    },
  )

  it("keeps text typed after the next Enter when an older hook arrives late", () => {
    const next = run(
      settled,
      key("content", at + 100),
      key("enter", at + 200),
      key("content", at + 300),
      key("enter", at + 400),
      key("content", at + 500),
    )
    const older = transition(next, { ...prompted(at + 600), firedAt: at + 250 }, 10_000)
    const newer = transition(older, { ...prompted(at + 900), firedAt: at + 700 }, 10_000)
    expect(newer).toMatchObject({ byPerson: false, box: { empty: false, doubted: false } })
    expect(transition(newer, stop).state).toBe("drafting")
  })

  it("keeps a later Escape for the newer prompt when the older hook arrives late", () => {
    const next = run(
      settled,
      key("content", at + 100),
      key("enter", at + 200),
      key("content", at + 300),
      key("enter", at + 400),
      key("escape", at + 800),
    )
    const older = transition(next, { ...prompted(at + 1000), firedAt: at + 250 }, 10_000)
    expect(older.box.escapedAt).toBe(at + 800)
    const newer = transition(older, { ...prompted(at + 1200), firedAt: at + 700 }, 10_000)
    expect(newer.state).toBe("unknown")
    expect(ringableSince(newer)).toBeUndefined()
  })

  it("recovers only the empty box after a late post-interruption prompt, without attributing it", () => {
    // Codex Windows: Escape +3432, Carry on Enter +7525, its hook fired +11996.
    const entered = run(
      working,
      key("escape", at + 3432),
      key("content", at + 7347),
      key("enter", at + 7525),
    )
    expect(entered.state).toBe("unknown")
    const prompt = { ...prompted(at + 12433, at + 12427.8293), firedAt: at + 11996 } as const
    const next = transition(entered, prompt, 10_000)
    const completed = transition(next, { ...stop, at: at + 12977 })
    expect(completed).toMatchObject({ state: "drafting", byPerson: false, box: { doubted: true } })
    expect(
      transition(completed, { type: "emptied", at: at + 13100, epoch: completed.epoch }),
    ).toMatchObject({ state: "settled", byPerson: false, box: { empty: true } })
    for (const kind of ["content", "neutral", "accept", "escape"] as const) {
      const changed = transition(entered, key(kind, at + 7800), 10_000)
      const result = run(transition(changed, prompt, 10_000), stop)
      expect(result.box.doubted).toBe(false)
      // The screen is the authority on the box, so a key that left it empty is no doubt
      // for it: Settled again, as the turn completed.
      expect(
        transition(result, { type: "emptied", at: at + 13100, epoch: result.epoch }).state,
      ).toBe("ready")
    }
    const asked = run(entered, key("content", at + 7800, true))
    expect(run(transition(asked, prompt, 10_000), stop).box.doubted).toBe(false)
    // Two submissions may leave a second queued prompt: never doubt alone.
    const twice = run(entered, key("content", at + 7600), key("enter", at + 7700))
    expect(run(transition(twice, prompt, 10_000), stop).box.doubted).toBe(false)
  })

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

  it("is judged by when the prompt's hook started, not when it was heard", () => {
    // A loaded machine boots the hook late: started just inside the window, heard past it.
    const late = run(
      drafting,
      key("enter"),
      prompted(at + submitWindowMs + 600, at + submitWindowMs - 500),
    )
    expect(late).toMatchObject({ byPerson: true, box: { empty: true } })
    expect(transition(late, stop).state).toBe("settled")
    // Started past the window, however soon it was heard: not the Enter's.
    const missed = run(
      drafting,
      key("enter"),
      prompted(at + submitWindowMs + 150, at + submitWindowMs + 100),
    )
    expect(missed.byPerson).toBe(false)
    expect(transition(missed, stop).state).toBe("drafting")
  })

  it("settles a late prompt's uncertain box after its completed turn without attributing it", () => {
    // Windows CI's emoji/CJK prompt: its hook's shell fired 2344 ms after Enter.
    // Offsets and fractional hook times replay the recorded round-09 transition.
    const origin = 1_792_029_901_205
    const events: readonly DeliveryEvent[] = [
      { type: "bound", ready: true, at: origin + 3464.6567, firedAt: origin + 2843 },
      key("content", origin + 3475),
      key("enter", origin + 3635),
      {
        type: "prompt",
        by: "prompt",
        at: origin + 6447,
        startedAt: origin + 6443.453,
        firedAt: origin + 5979,
      },
      { ...stop, at: origin + 7136, startedAt: origin + 7129.926 },
    ]
    const completed = events.reduce(
      (delivery, event) => transition(delivery, event, 10_000),
      unbound,
    )
    expect(completed).toMatchObject({
      state: "drafting",
      completedAt: origin + 7136,
      byPerson: false,
      box: { empty: false, doubted: true },
    })
    expect(ringableSince(completed)).toBeUndefined()
    const empty = { type: "emptied", at: origin + 8000, epoch: completed.epoch } as const
    const recovered = transition(completed, empty)
    expect(recovered).toMatchObject({ state: "settled", byPerson: false, box: { empty: true } })
    expect(ringableSince(recovered)).toBe(origin + 7136)
    expect(transition(completed, { ...empty, epoch: completed.epoch - 1 })).toBe(completed)
    // A key ends the doubt, but the screen decides what is in the box: empty, it is Settled.
    for (const kind of ["content", "neutral", "accept", "enter", "escape"] as const) {
      const changed = transition(completed, key(kind, origin + 7500))
      expect(changed.box.doubted).toBe(false)
      expect(["settled", "ready"]).toContain(transition(changed, empty).state)
    }
    // The next turn's own box, known not empty by its Enter, is read like any other.
    const next = run(completed, prompted(origin + 7800), stop)
    expect(next.box.doubted).toBe(false)
    expect(["drafting", "ready"]).toContain(transition(next, empty).state)
  })

  it("keeps real drafts and queued prompts out of a late prompt's screen recovery", () => {
    const late = prompted(at + 4000, at + 3000)
    const uncertain = run(drafting, enter, late)
    expect(uncertain).toMatchObject({ state: "working", byPerson: false, box: { doubted: true } })
    // A screen read while the turn runs cannot settle it.
    expect(transition(uncertain, { type: "emptied", at, epoch: uncertain.epoch })).toBe(uncertain)
    for (const before of [
      run(drafting, enter, key("content", at + 100)),
      run(drafting, enter, key("neutral", at + 100)),
      run(drafting, enter, key("escape", at + 100)),
      run(drafting, enter, key("content", at + 100, true)),
      run(working, typing, enter),
      run(working, typing, enter, stop, key("content", at + 100)),
    ]) {
      const completed = run(before, late, stop)
      expect(completed).toMatchObject({ state: "drafting", box: { doubted: false } })
      // Without a doubt, the screen alone settles it.
      expect(transition(completed, { type: "emptied", at, epoch: completed.epoch }).state).toBe(
        "ready",
      )
    }
    // The next hook of an actual queued prompt confirms its submission even when late.
    expect(run(working, typing, enter, stop, late, stop)).toMatchObject({
      state: "settled",
      byPerson: true,
      box: { doubted: false },
    })
  })

  it("is theirs when they typed only after its hook started, which leaves a draft", () => {
    // Heard after their next keys, though its hook started before them.
    const after = run(
      drafting,
      key("enter"),
      key("content", at + 400),
      prompted(at + 900, at + 300),
    )
    expect(after).toMatchObject({ byPerson: true, box: { empty: false } })
    expect(transition(after, stop).state).toBe("drafting")
    // Typed before its hook started: what was submitted is unknown.
    const before = run(
      drafting,
      key("enter"),
      key("content", at + 200),
      prompted(at + 900, at + 300),
    )
    expect(before.byPerson).toBe(false)
    expect(transition(before, stop).state).toBe("drafting")
  })

  it("is never a doorbell prompt, whenever its hook started", () => {
    const doorbell = { type: "prompt", by: "doorbell", nonce: "k3f9" } as const
    const rung = run(drafting, key("enter"), { ...doorbell, at: at + 900, startedAt: at + 300 })
    expect(rung.byPerson).toBe(false)
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

describe("whose turn it is", () => {
  it("is the person's only when their own submission started it", () => {
    expect(working.byPerson).toBe(true)
    // A prompt nobody's Enter came before, the harness's, or the doorbell's, is not.
    expect(run(settled, prompted()).byPerson).toBe(false)
    expect(run(settled, harness).byPerson).toBe(false)
    expect(run(settled, enter, harness).byPerson).toBe(false)
    expect(
      run(settled, { type: "prompt", by: "doorbell", nonce: "k3f9", at, startedAt: at }).byPerson,
    ).toBe(false)
    // It stays the person's turn through its later calls and continuations, until another.
    expect(run(working, call, continued, prompted()).byPerson).toBe(true)
    expect(run(working, stop, harness).byPerson).toBe(false)
    // A call while no turn runs resumes one, but nothing says the person started it.
    expect(run(working, stop, call).byPerson).toBe(false)
    expect(run(working, ended, call).byPerson).toBe(false)
    expect(run(working, binds).byPerson).toBe(false)
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

  it("leave the box as it was when only Enter answered, a draft after any other key", () => {
    expect(run(working, asked("enter"), { type: "asked-cleared" }, stop).state).toBe("settled")
    // Left, Right, Home, End and Tab too: the request may be stale, its dialog gone.
    for (const kind of ["neutral", "accept"] as const)
      expect(run(working, asked(kind), asked("enter"), { type: "asked-cleared" }, stop).state).toBe(
        "drafting",
      )
  })

  it("keep their draft until a confirmed submission undoes it", () => {
    const answering = run(working, asked("content"))
    expect(run(answering, person, { type: "asked-cleared" }, stop).state).toBe("settled")
  })
})

describe("when a message would reach an agent", () => {
  it("says so in send's words for each state", () => {
    expect(route(bound, false, undefined)).toBe("ringing it once its box reads empty")
    expect(route(transition(unbound, announced), false, undefined)).toBe("ringing it now")
    expect(route(working, false, undefined)).toBe("when its current turn ends")
    // Codex sends nothing when a turn fails.
    expect(route(working, true, undefined)).toBe("at its turn's end or its next prompt")
    expect(route(transition(working, background), false, undefined)).toBe(
      "when its next turn starts",
    )
    expect(route(settled, false, undefined)).toBe("ringing it now")
    for (const state of [drafting, unknown])
      expect(route(state, false, undefined)).toBe("ringing it once its box reads empty")
    // What the screen showed of why it can't be rung, in plain words.
    expect(route(drafting, false, undefined, "draft")).toBe(
      "waits: there's text in its box, rung once it is empty",
    )
    expect(route(unknown, false, undefined, "dialog")).toBe(
      "waits: a dialog or picker is open in its terminal, rung once it closes",
    )
    expect(route(bound, false, undefined, "asking")).toBe(
      "waits: it is asking the user a question, rung once answered",
    )
  })

  it("gives the reason an idle agent the doorbell can't ring waits, not 'now'", () => {
    const ready = transition(unbound, announced)
    expect(route(settled, false, undefined, "dialog")).toBe(
      "waits: a dialog or picker is open in its terminal, rung once it closes",
    )
    expect(route(ready, false, undefined, "away")).toBe(
      "waits: its terminal is not at the agent's prompt, rung once it is",
    )
    expect(route(ready, false, undefined, "failed")).toBe(
      "waits: its doorbell failed three times, rung again at its next prompt or key",
    )
    expect(route(settled, false, undefined, "draft")).toBe(
      "waits: there's text in its box, rung once it is empty",
    )
    expect(route(ready, false, undefined, "asking")).toBe(
      "waits: it is asking the user a question, rung once answered",
    )
  })
})

// Where a lead's message reaches a harness's running turn, from its profile.
const midTurnOf = ({ messaging }: (typeof harnesses)["claude"]) =>
  midTurnCall(messaging.call !== undefined, messaging.reinjectPerCall)

describe("when a lead's message would reach a running turn", () => {
  it("names the call each harness delivers it at", () => {
    expect(midTurnOf(harnesses.claude)).toBe("tool call")
    expect(midTurnOf(harnesses.codex)).toBe("tool call")
    expect(midTurnOf(harnesses.agy)).toBe("model call")
    expect(midTurnCall(false, false)).toBeUndefined()
  })

  it("tells the lead's message it reaches a running turn at its next tool call", () => {
    expect(route(working, false, "tool call")).toBe("at its next tool call")
    expect(route(working, false, "model call")).toBe("at its next model call")
    expect(route(working, true, "tool call")).toBe("at its next tool call")
    // Nothing runs to call a tool: it waits as any message does.
    expect(route(settled, false, "tool call")).toBe("ringing it now")
    expect(route(transition(working, background), false, "tool call")).toBe(
      "when its next turn starts",
    )
    expect(route(drafting, false, "tool call")).toBe("ringing it once its box reads empty")
  })
})

describe("a ring", () => {
  const ringing = transition(settled, { type: "ring", nonce: "k3f9", opening: false })
  const doorbell = { type: "prompt", by: "doorbell", nonce: "k3f9", at, startedAt: at } as const

  it("rings only a Settled terminal, its line a draft until its own prompt", () => {
    expect(ringing).toMatchObject({
      state: "ringing",
      nonce: "k3f9",
      touched: false,
      epoch: settled.epoch,
      box: { empty: false },
    })
    for (const from of [bound, working, drafting, unknown, unbound])
      expect(transition(from, { type: "ring", nonce: "k3f9", opening: false })).toBe(from)
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
    // A binding that replaces the session it rang takes its line as a draft; only a ring
    // of a prompt shown before any session binds goes on as its own prompt binds one.
    expect(transition(ringing, binds)).toMatchObject({ state: "fresh", box: { empty: false } })
    expect(transition(ringing, announced)).toMatchObject({
      state: "drafting",
      box: { empty: false },
    })
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

describe("a new session at its own prompt", () => {
  const ready = transition(unbound, announced)
  const doorbell = { type: "prompt", by: "doorbell", nonce: "k3f9", at, startedAt: at } as const

  it("is Ready once its harness announces it at its input prompt, rung since it bound", () => {
    expect(ready).toMatchObject({ state: "ready", since: at, box: { empty: true } })
    expect(ringableSince(ready)).toBe(at)
    // One bound with nothing showing its prompt is up, as a forked one, is never rung.
    expect(ringableSince(bound)).toBeUndefined()
    expect(transition(bound, { type: "ring", nonce: "k3f9", opening: false })).toBe(bound)
  })

  it("is Ready after a /clear the person submitted, in any bound state", () => {
    for (const from of [settled, drafting, unknown])
      expect(run(from, typing, enter, announced)).toMatchObject({ state: "ready", since: at })
    // After an Escape mid-turn, its box a draft: the /clear and its Enter came after it.
    expect(run(working, key("escape"), typing, enter, announced).state).toBe("ready")
  })

  it("takes an Enter in Unknown as the /clear only when the new session binds within the window", () => {
    // From Unknown the turn may have run on, so the Enter may have queued their line: a new
    // session binding just after it says it ran the command that replaced the old one.
    const late = { ...announced, at: at + submitWindowMs + 1 }
    expect(run(unknown, typing, enter, late).state).toBe("drafting")
    // Typed again before the session's hook started: their text is in the box.
    expect(run(unknown, typing, enter, typing, announced).state).toBe("drafting")
    // During a running turn, the Enter queued a prompt the harness may still hold.
    expect(run(working, typing, enter, announced).state).toBe("drafting")
    // A prompt queued by an earlier Enter, then the /clear's own: that prompt may stay.
    const queuedFirst = run(unknown, typing, enter, typing, key("enter", at + 500))
    expect(transition(queuedFirst, { ...announced, at: at + 600 }).state).toBe("drafting")
    // The /clear's Enter alone: Ready.
    expect(run(unknown, typing, key("enter", at + 500), { ...announced, at: at + 600 }).state).toBe(
      "ready",
    )
  })

  it("is Drafting when the person typed after their last Enter, as while the agent started", () => {
    // `claude`, Enter, then the first words of a prompt before its SessionStart.
    const typedAhead = run(unbound, typing, enter, typing, announced)
    expect(typedAhead).toMatchObject({ state: "drafting", box: { empty: false } })
    expect(ringableSince(typedAhead)).toBeUndefined()
    expect(run(unbound, typing, enter, announced).state).toBe("ready")
    // A draft left while a request waited stays too.
    expect(run(working, key("content", at, true), announced).state).toBe("drafting")
  })

  it("replaces a session only from a box known empty, or one the person's Enter just submitted", () => {
    // Nothing typed since its turn: a plan's "clear context", say.
    expect(transition(settled, announced).state).toBe("ready")
    // `\` then Enter makes a newline, an Enter may take a suggestion: no turn followed, so
    // their text may still be in the box when the new session binds.
    const late = { ...announced, at: at + submitWindowMs + 1 }
    expect(run(settled, typing, enter, late)).toMatchObject({
      state: "drafting",
      box: { empty: false },
    })
    // Drafting only by doubt: the screen showing the box empty settles it (a /clear that
    // took longer than the window, as on Windows), once, and not after a key of theirs.
    expect(late.at - at).toBeGreaterThan(submitWindowMs)
    const doubted = run(settled, typing, enter, late)
    expect(doubted.box.doubted).toBe(true)
    const empty = { type: "emptied", at: at + 5_000, epoch: doubted.epoch } as const
    expect(transition(doubted, empty)).toMatchObject({ state: "ready", box: { empty: true } })
    expect(transition(doubted, { ...empty, epoch: doubted.epoch - 1 })).toBe(doubted)
    // The screen is the authority on the box, whatever kept it a draft: a stale look, from
    // before a key of the person's, is dropped by messaging (`emptied` there).
    expect(transition(run(doubted, typing), empty).state).toBe("ready")
    // A key ends the doubt, a neutral one (Left may open a view) and one while asked too.
    expect(transition(doubted, key("neutral", at + 3_000)).box.doubted).toBe(false)
    const answering = transition(doubted, key("content", at + 3_000, true))
    expect(answering.box).toMatchObject({ doubted: false, draftWhileAsked: true })
    expect(transition(answering, empty).state).toBe("ready")
    // Escape at the prompt, and Enter or Escape while a request waits, end it as well.
    for (const ending of [key("escape", at + 3_000), key("enter", at + 3_000, true)]) {
      const after = transition(doubted, ending)
      expect(after.box.doubted).toBe(false)
      expect(transition(after, empty).state).toBe("ready")
    }
    // A prompt queued or held is no doubt: it starts the next session's turn. The screen
    // still decides: the harness shows what it holds (`BoxProfile.queued`), and the doorbell
    // reads the box empty only with none shown.
    const queued = run(working, typing, enter, late)
    expect(queued).toMatchObject({ state: "drafting", box: { doubted: false } })
    // Their /clear and its Enter, just before the binding: submitted.
    expect(run(settled, typing, enter, { ...announced, at: at + submitWindowMs }).state).toBe(
      "ready",
    )
  })

  it("keeps a prompt the person queued during a turn when a session replaces it", () => {
    // Their Enter during the turn queued a prompt, just before the new session bound.
    const queuing = run(working, typing, enter)
    expect(queuing.box).toMatchObject({ queuing: true, enteredAt: at })
    expect(transition(queuing, announced)).toMatchObject({
      state: "drafting",
      box: { empty: false },
    })
  })

  it("takes a first binding after the shell started it by the last Enter alone, however long ago", () => {
    const late = { ...announced, at: at + 60_000 }
    expect(run(unbound, typing, enter, late).state).toBe("ready")
    expect(run(unbound, typing, enter, typing, late).state).toBe("drafting")
  })

  it("keeps what the person typed after their last Enter through the binding's end", () => {
    // The next agent's keys, before its SessionStart, while the last one's end goes unseen.
    const typedAhead = run(settled, typing, enter, typing, { type: "unbound" })
    expect(typedAhead).toMatchObject({ state: "unbound", box: { typedSinceEnter: true } })
    expect(transition(typedAhead, announced).state).toBe("drafting")
    // A draft left while asked too, until the Enter that starts an agent.
    const asked = run(working, key("content", at, true), { type: "unbound" })
    expect(transition(asked, announced).state).toBe("drafting")
    expect(run(asked, typing, enter, announced).state).toBe("ready")
  })

  it("goes to Working at its own command-line doorbell prompt, with no ring", () => {
    // `claude "<line>"`, as `open_terminal(claude, message)` starts it.
    const started = transition(ready, doorbell)
    expect(started).toMatchObject({ state: "working", phase: "turn", box: { empty: true } })
    expect(ringableSince(started)).toBeUndefined()
    expect(run(started, stop).state).toBe("settled")
  })

  it("turns Drafting at the person's input, but not at keys while asked", () => {
    expect(run(ready, typing)).toMatchObject({ state: "drafting", box: { empty: false } })
    expect(run(ready, enter).state).toBe("drafting")
    expect(transition(ready, key("enter", at, true))).toEqual(ready)
  })

  it("rings like Settled: its own doorbell prompt confirms, a failure leaves it Unknown", () => {
    const ringing = transition(ready, { type: "ring", nonce: "k3f9", opening: false })
    expect(ringing).toMatchObject({ state: "ringing", nonce: "k3f9", box: { empty: false } })
    expect(transition(ringing, doorbell)).toMatchObject({
      state: "working",
      phase: "turn",
      epoch: ready.epoch + 1,
      box: { empty: true },
    })
    expect(transition(ringing, { type: "ring-failed", nonce: "k3f9" }).state).toBe("unknown")
    // The person typing mid-ring keeps their words as a draft.
    expect(run(ringing, typing, doorbell)).toMatchObject({ box: { empty: false } })
  })

  it("works once a root prompt starts its first turn, the person's own when they submitted it", () => {
    expect(run(ready, person)).toMatchObject({ state: "working", byPerson: true })
    expect(run(ready, harness)).toMatchObject({ state: "working", byPerson: false })
    expect(run(ready, person, stop).state).toBe("settled")
  })
})

// The agent's prompt shown at `time` for a session that replaces the one bound.
const replacing = (time: number) => ({ type: "shown", at: time, replaces: true }) as const

describe("an agent's prompt shown before any session binds", () => {
  const shown = { type: "shown", at, replaces: false } as const
  const ready = transition(unbound, shown)
  const doorbell = { type: "prompt", by: "doorbell", nonce: "k3f9", at, startedAt: at } as const

  it("is Ready since it showed, as Codex's title or Antigravity's status line tells", () => {
    expect(ready).toMatchObject({ state: "ready", since: at, box: { empty: true } })
    expect(ringableSince(ready)).toBe(at)
    // Shown again, as each title or status line says it, changes nothing.
    expect(transition(ready, { ...shown, at: at + 5_000 })).toBe(ready)
    // Bound already, the session's own events tell.
    expect(transition(settled, shown)).toBe(settled)
  })

  it("is Drafting when the person typed after the Enter that started it", () => {
    expect(run(unbound, typing, enter, typing, shown).state).toBe("drafting")
    expect(run(unbound, typing, enter, shown).state).toBe("ready")
    expect(run(ready, typing).state).toBe("drafting")
  })

  it("is rung, and its ring goes on as the ring's own prompt binds the session, which it confirms", () => {
    const ringing = transition(ready, { type: "ring", nonce: "k3f9", opening: true })
    const boundMidRing = transition(ringing, binds)
    expect(boundMidRing).toMatchObject({
      state: "ringing",
      nonce: "k3f9",
      epoch: ringing.epoch + 1,
    })
    expect(transition(boundMidRing, doorbell)).toMatchObject({
      state: "working",
      box: { empty: true },
    })
    // The person typed during the ring: their words stay a draft.
    expect(run(ringing, typing, binds, doorbell)).toMatchObject({ box: { empty: false } })
  })

  it("replaces a bound session as a binding at its prompt would, keeping a box that may hold text", () => {
    // Nothing typed since its turn, or the person's /clear and its Enter just before.
    expect(transition(settled, replacing(at))).toMatchObject({ state: "ready", since: at })
    expect(run(settled, typing, enter, replacing(at + submitWindowMs)).state).toBe("ready")
    // An Enter that started no turn, as a newline's, longer ago than the window.
    expect(run(settled, typing, enter, replacing(at + submitWindowMs + 1)).state).toBe("drafting")
    // An Enter after the title, judged as it came, submitted nothing then.
    expect(run(settled, typing, key("enter", at + 500), replacing(at)).state).toBe("drafting")
    // A prompt the person queued during the turn, which the harness may still hold.
    const queuing = run(working, typing, enter)
    expect(transition(queuing, replacing(at))).toMatchObject({ state: "drafting" })
    expect(transition(run(queuing, stop), replacing(at)).state).toBe("drafting")
    // Without replacing it, a bound session's own events tell.
    expect(transition(settled, { ...replacing(at), replaces: false })).toBe(settled)
  })

  it("is Unbound again once the agent leaves before any session bound", () => {
    expect(transition(ready, { type: "unbound" }).state).toBe("unbound")
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

  it("judges a prompt by when its hook's shell started, where the relay told", () => {
    const entered = run(drafting, key("enter"))
    // Its relay started 15 s after the Enter, behind a cold PowerShell; its shell 1 s after.
    const late = { ...prompted(at + 15_100, at + 15_000), firedAt: at + 1_000 } as const
    expect(transition(entered, late, 20_000).byPerson).toBe(true)
    // Its shell too started past the window: no slack makes it the person's.
    const past = { ...late, firedAt: at + submitWindowMs + 1 } as const
    expect(transition(entered, past, 20_000).byPerson).toBe(false)
  })

  it("takes a hook whose shell's start reads a clock tick before the Enter as after it", () => {
    const entered = run(drafting, key("enter"))
    // Windows' process start moves in ticks of about 15.6 ms, coarser than the Enter's.
    const sameTick = { ...prompted(at + 900, at + 800), firedAt: at - 10 } as const
    expect(transition(entered, sameTick, 20_000).byPerson).toBe(true)
    const before = { ...sameTick, firedAt: at - 100 } as const
    expect(transition(entered, before, 20_000).byPerson).toBe(false)
  })

  it("widens by the shell's slack only where the hook's shell start isn't told", () => {
    const entered = run(drafting, key("enter"))
    const late = prompted(at + 15_100, at + 15_000)
    expect(transition(entered, late, 20_000).byPerson).toBe(true)
    expect(transition(entered, late, 0).byPerson).toBe(false)
  })

  it("keeps a key typed while a held-back hook may still come as the person's draft", () => {
    const entered = run(drafting, key("enter"))
    const strayed = transition(entered, key("neutral", at + 5_000), 20_000)
    expect(strayed.box.strayed).toBe(true)
    expect(transition(entered, key("neutral", at + 5_000), 0).box.strayed).toBe(false)
  })
})

describe("an idle agent whose screen shows its box empty", () => {
  const emptied = (of: Delivery, change: { at?: number; epoch?: number } = {}) =>
    transition(of, { type: "emptied", at: at + 9_000, epoch: change.epoch ?? of.epoch })

  it("is Ready whatever doubt held it Drafting, Unknown or Fresh", () => {
    // Fresh: bound, nothing showed its prompt up.
    expect(bound.state).toBe("fresh")
    expect(emptied(bound)).toMatchObject({
      state: "ready",
      since: at + 9_000,
      box: { empty: true },
    })
    // Drafting: the person answered a request in its dialog, which leaves a draft by doubt.
    const answered = run(working, key("content", at, true), { type: "asked-cleared" }, stop)
    expect(answered.state).toBe("drafting")
    expect(emptied(answered).state).toBe("ready")
    // Drafting: a stray key at the prompt, the box left empty.
    const stray = run(settled, key("content", at + 100))
    expect(stray.state).toBe("drafting")
    expect(emptied(stray).state).toBe("ready")
    // Unknown: an Escape, a denial, a failed turn, a ring that never confirmed.
    const ringing = transition(settled, { type: "ring", nonce: "k3f9", opening: false })
    const failed = transition(ringing, { type: "ring-failed", nonce: "k3f9", ours: true })
    expect(failed.state).toBe("unknown")
    expect(emptied(failed).state).toBe("ready")
    expect(emptied(run(working, ended)).state).toBe("ready")
    expect(ringableSince(emptied(failed))).toBe(at + 9_000)
  })

  it("leaves a turn running and a ring under way alone", () => {
    expect(emptied(working)).toBe(working)
    expect(emptied(settled)).toBe(settled)
    const ringingNow = transition(settled, { type: "ring", nonce: "k3f9", opening: false })
    expect(emptied(ringingNow)).toBe(ringingNow)
  })

  it("takes a prompt thought queued as no bar once the harness' time to submit it has passed", () => {
    // Windows' hooks are slow: the person's arrow and Enter in a question's dialog come before
    // its request is heard (`asked` false), so the Enter reads as a prompt queued behind the turn.
    const queuedTurn = run(working, typing, enter, stop)
    expect(queuedTurn).toMatchObject({
      state: "drafting",
      box: { queued: true, queuedAt: at },
    })
    const look = (when: number) =>
      transition(queuedTurn, { type: "emptied", at: when, epoch: queuedTurn.epoch })
    // The harness may have submitted that prompt itself, its hook late: the screen's empty
    // box is not believed for a while after the Stop, or the turn would be misattributed.
    expect(queueBarLeft(queuedTurn, at + 1_000, 0)).toBe(queueBarMs(0) - 1_000)
    expect(look(at + 1_000)).toBe(queuedTurn)
    expect(look(at + queueBarMs(0) - 1)).toBe(queuedTurn)
    // Past it, with nothing started, the screen decides: a dialog's Enter ends Ready.
    expect(queueBarLeft(queuedTurn, at + queueBarMs(0), 0)).toBe(0)
    expect(look(at + queueBarMs(0)).state).toBe("ready")
    // A slower hook shell widens the bar by its slack.
    expect(queueBarMs(15_000)).toBe(queueBarMs(0) + 15_000)
  })

  it("keeps #184's late-prompt case behind the bar until the prompt's hook, or the bar's end", () => {
    // A queued prompt the harness submits at the Stop: its hook comes late, as its own turn.
    const late = prompted(at + 4000, at + 3000)
    const queuedTurn = run(working, typing, enter, stop)
    const barred = transition(queuedTurn, {
      type: "emptied",
      at: at + 2_000,
      epoch: queuedTurn.epoch,
    })
    expect(barred).toBe(queuedTurn)
    // The hook arrives: the turn starts as the person's queued prompt, nothing to read.
    expect(transition(queuedTurn, late).state).toBe("working")
  })

  it("is dropped when a turn or a session came since the look", () => {
    const answered = run(working, key("content", at, true), { type: "asked-cleared" }, stop)
    expect(emptied(answered, { epoch: answered.epoch - 1 })).toBe(answered)
  })

  it("keeps the counts of its last turn, and starts a new one from the doorbell's prompt", () => {
    const failed = run(working, ended)
    const ready = emptied(failed)
    expect(ready).toMatchObject({ epoch: failed.epoch, continued: failed.continued })
    const rung = transition(transition(ready, { type: "ring", nonce: "k3f9", opening: false }), {
      type: "prompt",
      by: "doorbell",
      nonce: "k3f9",
      at,
      startedAt: at,
    })
    expect(rung.state).toBe("working")
  })
})

describe("the line a failed ring left in the box", () => {
  const rung = transition(settled, { type: "ring", nonce: "k3f9", opening: false })
  const failed = transition(rung, { type: "ring-failed", nonce: "k3f9", ours: true })
  const resume = { type: "ring", nonce: "k3f9", opening: false, leftover: true } as const

  it("is Novadeck's own while the person typed nothing since", () => {
    expect(failed).toMatchObject({ state: "unknown", box: { ours: true, empty: false } })
    // Rung again under its own nonce, pasting nothing; a repeat fails the same way.
    const again = transition(failed, resume)
    expect(again).toMatchObject({ state: "ringing", nonce: "k3f9", touched: false })
    expect(again.box.ours).toBe(false)
    expect(transition(again, { type: "ring-failed", nonce: "k3f9", ours: true }).box.ours).toBe(
      true,
    )
    // A ring whose paste check rejected its line leaves it nobody's to submit.
    expect(transition(again, { type: "ring-failed", nonce: "k3f9" }).box.ours).toBe(false)
    // Its prompt confirms it as any ring's.
    expect(
      transition(again, { type: "prompt", by: "doorbell", nonce: "k3f9", at, startedAt: at }).state,
    ).toBe("working")
  })

  it("is the person's draft once they press any key, or a turn starts", () => {
    for (const kind of ["content", "enter", "neutral", "accept"] as const) {
      const after = transition(failed, key(kind, at + 10))
      expect(after.box.ours).toBe(false)
      expect(transition(after, resume)).toBe(after)
    }
    expect(transition(failed, key("content", at + 10, true)).box.ours).toBe(false)
    expect(transition(failed, prompted(at + 10)).box.ours).toBe(false)
  })

  it("is the person's draft when they typed during the ring", () => {
    const touched = transition(rung, key("content", at + 10))
    expect(touched).toMatchObject({ state: "ringing", touched: true })
    expect(transition(touched, { type: "ring-failed", nonce: "k3f9", ours: true }).box.ours).toBe(
      false,
    )
  })

  it("is only resumed from an idle state that left it, never a Settled, Working or other draft", () => {
    expect(transition(settled, resume)).toMatchObject({ state: "ringing" })
    expect(transition(working, resume)).toBe(working)
    expect(transition(drafting, resume)).toBe(drafting)
  })
})
