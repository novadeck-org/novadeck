import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it } from "../test.js"
import {
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
  events.flat().reduce(transition, from)

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
const prompted = (time = at + 100, startedAt = time): DeliveryEvent => ({
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
    const stale = run(settled, enter, key("neutral", at + 5_000))
    expect(stale.state).toBe("drafting")
    const next = run(stale, key("enter", at + 6_000), prompted(at + 6_100))
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
    // A loaded machine boots the hook late: started 1.5 s after the Enter, heard at 2.6 s.
    const late = run(drafting, key("enter"), prompted(at + 2_600, at + 1_500))
    expect(late).toMatchObject({ byPerson: true, box: { empty: true } })
    expect(transition(late, stop).state).toBe("settled")
    // Started past the window, however soon it was heard: not the Enter's.
    const missed = run(drafting, key("enter"), prompted(at + 2_150, at + 2_100))
    expect(missed.byPerson).toBe(false)
    expect(transition(missed, stop).state).toBe("drafting")
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
    expect(route(bound, false, undefined)).toBe("when its agent's first turn starts")
    expect(route(transition(unbound, announced), false, undefined)).toBe("ringing it now")
    expect(route(working, false, undefined)).toBe("when its current turn ends")
    // Codex sends nothing when a turn fails.
    expect(route(working, true, undefined)).toBe("at its turn's end or its next prompt")
    expect(route(transition(working, background), false, undefined)).toBe(
      "when its next turn starts",
    )
    expect(route(settled, false, undefined)).toBe("ringing it now")
    for (const state of [drafting, unknown])
      expect(route(state, false, undefined)).toBe("when the user next submits a prompt there")
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
    expect(route(drafting, false, "tool call")).toBe("when the user next submits a prompt there")
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
})
