import type { HarnessEvent } from "@novadeck/harness-core/events"

/** Windows never span more than a thread's ten minutes; history is kept three times that. */
export const keepMs = 30 * 60_000

/** The most entries of any one kind a terminal keeps: the oldest go first. */
export const keepEntries = 500

/** A background task counts as work only this long after it started: a thread's length. */
export const taskWorkMs = 10 * 60_000

/** Root turns that ran this long in all inside a window worked, calls or none. */
export const turnWorkMs = 60_000

/** A send counts as a call reported this long after it: inside the window it opens. */
const justAfter = 0.5

/** The "actor" of the subagents an Antigravity-style status line counts running. */
const statusLine = "\0status-line"

/** A span `[start, end)` of something running; `end` is null while it does. */
type Span = { start: number; end: number | null }

type Request = Span & { readonly id: string; readonly actor: string | null }
type Subagent = Span & { readonly actor: string }

/** A turn's edge: its start, a Stop that ended it, or a Stop Novadeck continued. */
type Mark = {
  readonly at: number
  /** The event's own time, which orders it against the others as the activity does. */
  readonly startedAt: number
  readonly kind: "start" | "stop" | "continue"
  /** A stop only a status line or an Escape told, which a working turn may contradict. */
  readonly soft?: true
}

type History = {
  /** A session was observed since the last reset. */
  session: boolean
  /** The session reported a call, or the terminal sent: its harness is known to report. */
  called: boolean
  /** Nothing is known before this: when watching began, or the oldest history dropped. */
  since: number
  /** Reports of `work` calls. */
  work: number[]
  /** Reports of `waiting` calls: time spent in a turn around them was spent waiting. */
  waits: number[]
  /** Reports of calls of every kind, and each send just after it. */
  calls: number[]
  prompts: number[]
  marks: Mark[]
  subagents: Subagent[]
  requests: Request[]
  tasks: Span[]
}

const within = (span: Span, from: number, to: number): boolean =>
  span.start <= to && (span.end === null || span.end > from)

const inside = (times: readonly number[], from: number, to: number): boolean =>
  times.some((at) => at > from && at <= to)

/**
 * What each terminal's agent did between two moments, for the loop hold
 * (docs/agent-messaging.md, Guards, "Loops"): whether it worked, so a message sent while
 * neither end of its thread did is idle. Fed every harness event a terminal's session
 * reports, as it reaches the runner, and each send the terminal makes; kept in memory only,
 * so a runner restart forgets it.
 *
 * Approximations, where the events don't say: a background task a `work` call started runs
 * until the turn end that leaves none (`background.tasks`, or no `background` at all) or
 * fewer than were open, which ends the oldest first (the count includes tasks a waiting
 * call started, so it errs toward keeping them); it can't see one finish between turn ends.
 * A subagent runs from its start to its stop or abort. Order is arrival order: events come
 * in with non-decreasing `at`.
 */
export class Loops {
  private readonly terminals = new Map<string, History>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Harness events the terminal's session reported, root and subagents, as they reached the
   * runner at `at`: `tool-called` reports, subagents starting and stopping, turns starting
   * and ending (and what they leave in the background), requests waiting on the person, and
   * prompts the person typed.
   */
  observe(terminalId: string, events: readonly HarnessEvent[], at: number = this.now()): void {
    const history = this.history(terminalId, at)
    for (const event of events) fold(history, event, at)
    prune(history, at)
  }

  /**
   * The terminal sent a message at `at`: counted as its own call reported just after it,
   * whatever its harness reports of the `send`, so a turn that only sent never passes for
   * one at work. It doesn't make the session known: only a reported call does.
   */
  sent(terminalId: string, at: number): void {
    const history = this.history(terminalId, at)
    // Only a reported call proves the harness reports them: a send never sets `called`.
    history.calls.push(at + justAfter)
    prune(history, at)
  }

  /**
   * Whether the terminal worked after `from` up to `to`: made a call of kind `work`, root or
   * subagent, whose report reached the runner in that time; had a subagent that hadn't
   * aborted, a background task a working call started, or a request waiting on the person,
   * at any moment of it; ran one turn through all of it without any call of its reporting;
   * or the person typed a prompt in it. `"unknown"` where it can't tell: no session bound
   * there, a session that hasn't reported any call yet (its harness may not report them),
   * or `from` before the runner started watching it. The loop hold counts unknown as work.
   */
  worked(terminalId: string, from: number, to: number): boolean | "unknown" {
    const history = this.terminals.get(terminalId)
    if (!history?.session || !history.called || from < history.since) return "unknown"
    if (inside(history.work, from, to) || inside(history.prompts, from, to)) return true
    if (
      history.subagents.some((span) => within(span, from, to)) ||
      history.tasks.some((span) => within(limited(span), from, to)) ||
      history.requests.some((span) => within(span, from, to))
    ) {
      return true
    }
    return (
      ranThrough(history, from, to) ||
      (!inside(history.waits, from, to) && ranLong(history, from, to))
    )
  }

  /** The terminal's session ended or changed: what it did before no longer says anything. */
  reset(terminalId: string): void {
    if (this.terminals.has(terminalId)) this.terminals.set(terminalId, fresh(this.now()))
  }

  /** The terminal is gone. */
  forget(terminalId: string): void {
    this.terminals.delete(terminalId)
  }

  private history(terminalId: string, at: number): History {
    let history = this.terminals.get(terminalId)
    if (!history) {
      history = fresh(at)
      this.terminals.set(terminalId, history)
    }
    return history
  }
}

const fresh = (since: number): History => ({
  session: false,
  called: false,
  since,
  work: [],
  waits: [],
  calls: [],
  prompts: [],
  marks: [],
  subagents: [],
  requests: [],
  tasks: [],
})

/** A task's span as work: its first `taskWorkMs`, though it may run on (a dev server). */
const limited = (span: Span): Span => ({
  start: span.start,
  end: Math.min(span.end ?? Infinity, span.start + taskWorkMs),
})

/**
 * Root turns ran `turnWorkMs` in all inside the window, from a start mark or its start.
 * Not asked of a window with a waiting call reported in it, whose time was spent waiting:
 * a poller that sleeps and sends in one long turn is never at work for it.
 */
const ranLong = (history: History, from: number, to: number): boolean => {
  let total = 0
  let since: number | null = null
  for (const mark of history.marks) {
    if (mark.at > to) break
    if (mark.at <= from) since = mark.kind === "stop" ? null : from
    else if (mark.kind === "stop") {
      if (since !== null) total += mark.at - since
      since = null
    } else since ??= mark.at
  }
  if (since !== null) total += to - since
  return total >= turnWorkMs
}

/** One turn was running at `from` and neither stopped nor reported a call up to `to`. */
const ranThrough = (history: History, from: number, to: number): boolean => {
  let running = false
  for (const mark of history.marks) {
    if (mark.at > from) break
    running = mark.kind !== "stop"
  }
  if (!running) return false
  const stopped = history.marks.some(
    (mark) => mark.kind !== "start" && mark.at > from && mark.at <= to,
  )
  return !stopped && !inside(history.calls, from, to)
}

/** Ends the open spans the filter picks, at `at`. */
const close = <T extends Span>(spans: T[], at: number, pick: (span: T) => boolean): void => {
  for (const span of spans) if (span.end === null && pick(span)) span.end = at
}

/**
 * Pushes a stop mark. One right after a stop says nothing new (Antigravity's idle status
 * line repeats every draw, and would fill the cap), save a real Stop after a soft one.
 */
const pushStop = (
  history: History,
  event: { startedAt: number },
  at: number,
  soft: boolean,
): void => {
  const last = history.marks.at(-1)
  if (last?.kind === "stop" && (soft || !last.soft)) return
  history.marks.push({ at, startedAt: event.startedAt, kind: "stop", ...(soft && { soft: true }) })
}

/** A stop mark, unless the event is older than the turn it would end: a stale signal. */
const stop = (history: History, event: { startedAt: number }, at: number): boolean => {
  const latest = history.marks.findLast((mark) => mark.kind === "start")
  if (latest && event.startedAt < latest.startedAt) return false
  pushStop(history, event, at, true)
  return true
}

/**
 * A turn that stopped yet shows signs of running (a root call, a working status) runs on.
 * A working status only resumes a stop a status line or an Escape told, never a real Stop
 * (it can still say working just after one); a call only if not older than that stop, as a
 * late report of a call made before it is.
 */
const resume = (
  history: History,
  event: { startedAt: number },
  at: number,
  by: "call" | "status",
): void => {
  const last = history.marks.at(-1)
  if (last?.kind !== "stop") return
  if (by === "status" ? !last.soft : event.startedAt < last.startedAt) return
  history.marks.push({ at, startedAt: event.startedAt, kind: "start" })
}

const fold = (history: History, event: HarnessEvent, at: number): void => {
  switch (event.type) {
    case "session-observed":
      history.session = true
      return
    case "tool-called":
      history.called = true
      history.calls.push(at)
      if (event.actor === null) resume(history, event, at, "call")
      if (event.kind === "waiting") history.waits.push(at)
      if (event.kind === "work") {
        history.work.push(at)
        if (event.background) history.tasks.push({ start: at, end: null })
      }
      return
    case "subagent-started":
      history.subagents.push({ start: at, end: null, actor: event.actor })
      return
    case "subagent-stopped":
    case "subagent-turn-aborted":
      close(history.subagents, at, (span) => span.actor === event.actor)
      close(history.requests, at, (span) => span.actor === event.actor)
      return
    case "turn-started":
      settle(history, at)
      history.marks.push({ at, startedAt: event.startedAt, kind: "start" })
      if (event.cause === "prompt") history.prompts.push(at)
      return
    case "turn-idle":
      if (stop(history, event, at)) settle(history, at)
      counted(history, event.background.agents, at)
      return
    case "turn-lapsed":
      // The continuation never came: the turn ended at its Stop after all.
      settle(history, at)
      pushStop(history, event, at, false)
      return
    case "turn-escaped":
      if (stop(history, event, at)) settle(history, at)
      return
    case "turn-working":
      resume(history, event, at, "status")
      if (event.running !== undefined) counted(history, event.running, at)
      return
    case "turn-ended": {
      pushStop(history, event, at, false)
      if (event.outcome === "interrupted") {
        // The subagents the turn started end with it; the activity drops them.
        const from = turnStart(history)
        close(history.subagents, at, (span) => from !== null && span.start >= from)
      }
      settle(history, at)
      // Antigravity's Stop says `more` of something it can't count: no count then.
      if (event.background && !event.background.more) counted(history, event.background.agents, at)
      const open = history.tasks.filter((span) => span.end === null)
      const keep = event.background?.more ? open.length : (event.background?.tasks ?? 0)
      for (const span of open.slice(0, Math.max(0, open.length - keep))) span.end = at
      return
    }
    case "turn-continued":
      history.marks.push({ at, startedAt: event.startedAt, kind: "continue" })
      return
    case "attention-requested":
      history.requests.push({ id: event.requestId, actor: event.actor, start: at, end: null })
      // A subagent not seen running runs from its request on, as the activity takes it.
      if (event.actor !== null && !running(history, event.actor)) {
        history.subagents.push({ start: at, end: null, actor: event.actor })
      }
      return
    case "attention-resolved":
      close(history.requests, at, (span) => span.id === event.requestId)
      return
    default:
      return
  }
}

const running = (history: History, actor: string): boolean =>
  history.subagents.some((span) => span.end === null && span.actor === actor)

/** When the latest turn started, if any. */
const turnStart = (history: History): number | null =>
  history.marks.findLast((mark) => mark.kind === "start")?.at ?? null

/**
 * A root turn's start or end settles the requests it leaves: the root's own, which Claude
 * Code reports no denial or Escape of, and those of a subagent no longer running. A running
 * subagent's outlives the turn.
 */
const settle = (history: History, at: number): void => {
  close(history.requests, at, (span) => span.actor === null || !running(history, span.actor))
}

/**
 * A status line's count of subagents running (Antigravity names none): from a count above
 * zero until a later zero. The turn's end and idle report it as `background.agents` too.
 */
const counted = (history: History, agents: number, at: number): void => {
  const open = running(history, statusLine)
  if (agents > 0 && !open) history.subagents.push({ start: at, end: null, actor: statusLine })
  if (agents === 0 && open) close(history.subagents, at, (span) => span.actor === statusLine)
}

/** Drops what is older than `keepMs` or beyond the cap, and moves `since` past it. */
const prune = (history: History, at: number): void => {
  const cutoff = at - keepMs
  const forget = (time: number): void => {
    history.since = Math.max(history.since, time)
  }
  const times = (list: number[]): void => {
    let drop = list.findIndex((time) => time >= cutoff)
    if (drop < 0) drop = list.length
    drop = Math.max(drop, list.length - keepEntries)
    if (drop > 0) {
      forget(list[drop - 1]!)
      list.splice(0, drop)
    }
  }
  const spans = <T extends Span>(list: T[]): void => {
    for (let i = list.length - 1; i >= 0; i--) {
      const end = list[i]!.end
      if (end !== null && end < cutoff) {
        forget(end)
        list.splice(i, 1)
      }
    }
    // Over the cap the oldest closed span goes; an open one is never dropped, so a span
    // still running is never read as absent.
    while (list.length > keepEntries) {
      const index = list.findIndex((span) => span.end !== null)
      if (index < 0) break
      forget(list[index]!.end!)
      list.splice(index, 1)
    }
  }
  times(history.work)
  times(history.waits)
  times(history.calls)
  times(history.prompts)
  spans(history.subagents)
  spans(history.requests)
  spans(history.tasks)
  // Marks keep the state before the oldest one that stays, as a start or a stop.
  const marks = history.marks
  let drop = marks.findIndex((mark) => mark.at >= cutoff)
  if (drop < 0) drop = marks.length
  drop = Math.max(drop - 1, marks.length - keepEntries, 0)
  if (drop > 0) {
    forget(marks[drop - 1]!.at)
    marks.splice(0, drop)
  }
}
