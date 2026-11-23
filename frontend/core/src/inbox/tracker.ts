import { agentWorking } from "../agents/finish"
import type { ChatAnswer } from "../conversation"
import type { InboxAnswer, InboxEntry, InboxState } from "../inbox"
import type { TerminalKey, TerminalMetadata } from "../types"
import { reuse } from "./entries"

// What a backend that builds its Inbox from the app's state does with the person's answers,
// the same for the runner and the demo: which entries were seen, which answers are on their
// way, took, or failed, and what each kind of answer asks of the backend. The adapters keep
// only where their entries and answers come from.

// Why an answer didn't take, as the person reads it.
export const answerFailure = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "That didn't take. Try again."

// The terminal an entry is about, by its full address.
export const keyOf = ({ source }: InboxEntry): TerminalKey => ({
  projectId: source.projectId,
  workspaceSessionId: source.workspaceSessionId,
  terminalId: source.terminalId,
})

// Whether an entry is a stored turn entry (read by id), as its `stored` mark says, not the failed
// entry derived from a limited end, which no read touches.
export const isTurnEntry = (entry: InboxEntry): boolean =>
  entry.kind === "trouble" && entry.trouble.type === "failed" && entry.trouble.stored === true

// The state as it was when nothing changed in it, so what subscribes to it stays quiet.
export const keepInbox = (current: InboxState, next: InboxState): InboxState => {
  const entries = reuse(current.items, next.items)
  return entries === current.items &&
    JSON.stringify(next.answering) === JSON.stringify(current.answering) &&
    JSON.stringify(next.failed) === JSON.stringify(current.failed)
    ? current
    : { items: entries, answering: next.answering, failed: next.failed }
}

// What the tracker shows of the entries a backend found: the `seen` ones marked, and which
// are answering or have failed. A backend adds what it tracks itself before it publishes.
export type InboxView = {
  readonly items: readonly InboxEntry[]
  readonly answering: Record<string, true>
  readonly failed: Record<string, string>
}

export type InboxTrackerOptions = {
  // How long an answer to trouble may leave its entry standing before it can be answered
  // again.
  readonly settleMs: number
  // The tracker changed what the Inbox shows: the backend recomputes it.
  readonly changed: () => void
  // Keeps a call the backend waits for before it stops, as its other calls are.
  readonly track?: <T>(work: Promise<T>) => Promise<T>
}

export type InboxTracker = {
  readonly view: (found: readonly InboxEntry[]) => InboxView
  readonly see: (id: string) => void
  // Runs an answer: its entry shows answering until the backend drops it or the answer fails.
  // With `settles`, an answer that took but left its entry standing (a prompt that started no
  // turn) gives the buttons back after `settleMs`. `onError` runs when the answer fails;
  // with `silent`, a failure leaves no error behind: the entry just stands as it was.
  readonly call: (
    id: string,
    work: () => Promise<unknown>,
    options?: {
      readonly settles?: boolean
      readonly silent?: boolean
      readonly onError?: () => void
    },
  ) => void
  // Marks answers as sent, for the ones the backend sends itself.
  readonly submit: (ids: readonly string[]) => void
  readonly fail: (id: string, message: string) => void
  // Keeps a failure for the view after this one, with no change to announce.
  readonly note: (id: string, message: string) => void
  readonly forgive: (id: string) => void
  // Calls `changed` when the earliest of `waits` (milliseconds from now) is up; the ones
  // up already don't count.
  readonly wake: (waits: readonly number[]) => void
  // Whether what is on its way now still speaks to the Inbox when it lands: false once the
  // backend was unbound or stopped since. For the answers a backend sends itself.
  readonly guard: () => () => boolean
  // Forgets everything, as the backend stops being bound. An answer still on its way says
  // nothing to the next binding.
  readonly reset: () => void
  // Stops its timers, for a backend that is ending.
  readonly stop: () => void
}

export const createInboxTracker = ({
  settleMs,
  changed,
  track = (work) => work,
}: InboxTrackerOptions): InboxTracker => {
  const seen = new Set<string>()
  // What the person answered, until the entry goes; and why an answer didn't take.
  const submitted = new Set<string>()
  const inFlight = new Set<string>()
  const failed = new Map<string, string>()
  // Per entry, when its answer is given up on if the entry still stands.
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  // Per entry, its latest call: an earlier one's answer, landing late, speaks for nothing.
  const latest = new Map<string, object>()
  let due: ReturnType<typeof setTimeout> | undefined
  let round = 0

  const stop = (): void => {
    for (const timer of settling.values()) clearTimeout(timer)
    settling.clear()
    clearTimeout(due)
    due = undefined
  }

  const fail = (id: string, message: string): void => {
    submitted.delete(id)
    failed.set(id, message)
    changed()
  }

  return {
    view: (found) => {
      const ids = new Set(found.map((entry) => entry.id))
      // A resolved entry has nothing left to be seen for.
      const open = new Set(found.filter((entry) => !entry.settled).map((entry) => entry.id))
      for (const id of seen) if (!open.has(id)) seen.delete(id)
      for (const id of submitted) if (!ids.has(id) && !inFlight.has(id)) submitted.delete(id)
      // An entry the backend now lists resolved has taken its answer: it no longer answers.
      for (const entry of found)
        if (entry.settled && !inFlight.has(entry.id)) submitted.delete(entry.id)
      const entries = found.map((entry) => (seen.has(entry.id) ? { ...entry, seen: true } : entry))
      const answering: Record<string, true> = Object.fromEntries(
        [...inFlight].map((id) => [id, true]),
      )
      // A resolved entry has nothing on its way, though what it was said it was answered.
      for (const entry of entries)
        if (
          !entry.settled &&
          (submitted.has(entry.id) || (entry.kind === "request" && entry.request.answered))
        )
          answering[entry.id] = true
      return { items: entries, answering, failed: Object.fromEntries(failed) }
    },
    see: (id) => {
      if (seen.has(id)) return
      seen.add(id)
      changed()
    },
    call: (id, work, { settles = false, silent = false, onError } = {}) => {
      clearTimeout(settling.get(id))
      settling.delete(id)
      failed.delete(id)
      submitted.add(id)
      inFlight.add(id)
      changed()
      const binds = round
      const self = {}
      latest.set(id, self)
      const current = () => binds === round && latest.get(id) === self
      track(work()).then(
        () => {
          if (!current()) return
          latest.delete(id)
          inFlight.delete(id)
          changed()
          if (!settles) return
          settling.set(
            id,
            setTimeout(() => {
              settling.delete(id)
              if (submitted.delete(id)) changed()
            }, settleMs),
          )
        },
        (error: unknown) => {
          if (!current()) return
          latest.delete(id)
          inFlight.delete(id)
          onError?.()
          if (silent) {
            submitted.delete(id)
            changed()
          } else fail(id, answerFailure(error))
        },
      )
    },
    submit: (ids) => {
      for (const id of ids) submitted.add(id)
    },
    fail,
    note: (id, message) => {
      failed.set(id, message)
    },
    forgive: (id) => {
      failed.delete(id)
    },
    wake: (waits) => {
      clearTimeout(due)
      due = undefined
      const coming = waits.filter((wait) => wait > 0)
      if (coming.length > 0) due = setTimeout(changed, Math.min(...coming))
    },
    guard: () => {
      const binds = round
      return () => binds === round
    },
    reset: () => {
      stop()
      for (const known of [seen, inFlight, submitted, failed, latest]) known.clear()
      round += 1
    },
    stop: () => {
      stop()
      round += 1
    },
  }
}

type RequestEntry = Extract<InboxEntry, { kind: "request" }>

// What answering an entry asks of the backend; each is its own way to reach the agent.
export type InboxActions = {
  readonly request: (key: TerminalKey, entry: RequestEntry, answer: ChatAnswer) => Promise<unknown>
  readonly release: (thread: string) => void
  readonly stop: (thread: string) => void
  // Marks stored entries read by id, tracked: they show answering until the backend drops them.
  readonly read: (ids: readonly string[]) => void
  // Reads stored entries by id and says nothing of it: for a nudge that already took.
  readonly forget: (ids: readonly string[]) => void
  // `automatic` for the trouble entry's fixed lines, not words the person wrote: the agent's
  // turn on one takes no open ask out of the Inbox.
  readonly send: (
    key: TerminalKey,
    text: string,
    options?: { readonly automatic?: true },
  ) => Promise<unknown>
  readonly interrupt: (key: TerminalKey) => Promise<unknown>
  // Takes back a shipping permit that stands for the key's agent; rejects with why not, also
  // where it no longer stood.
  readonly takeBack: (key: TerminalKey, permit: string) => Promise<unknown>
  // The entry's terminal now, to see whether its agent works.
  readonly terminal: (key: TerminalKey) => TerminalMetadata | undefined
}

// Answers an entry as its kind asks: a request through the agent's conversation, a held thread
// released or stopped, a finish read, trouble by continuing, stopping or nudging the agent
// (a nudge interrupts it first if it works, except on a stored failed entry, which is nudged
// only while it is the agent's current end and the agent rests, never interrupting, and
// read once the nudge is sent). An
// answer of another kind fails; the kinds a backend answers itself (an ask, a told or done
// update) it handles before this.
export const answerEntry = (
  tracker: InboxTracker,
  entry: InboxEntry,
  given: InboxAnswer,
  actions: InboxActions,
): void => {
  const { id } = entry
  if (entry.kind !== given.kind) return tracker.fail(id, "That answer isn't for this item.")
  const key = keyOf(entry)
  if (entry.kind === "request" && given.kind === "request")
    return tracker.call(id, () => actions.request(key, entry, given.answer))
  if (entry.kind === "held" && given.kind === "held") {
    tracker.forgive(id)
    const { threadId } = entry.held
    if (given.action === "release") actions.release(threadId)
    else actions.stop(threadId)
    return
  }
  if (entry.kind === "update" && given.kind === "update") {
    tracker.forgive(id)
    // A newer Novadeck's entry is never marked read from here: its agent may wait on it.
    if (entry.update.type === "newer") return
    return actions.read([id])
  }
  if (entry.kind === "permit" && given.kind === "permit")
    return tracker.call(id, () => actions.takeBack(key, entry.permit.id), { settles: true })
  if (entry.kind === "trouble" && given.kind === "trouble") {
    const { action } = given
    const settles = { settles: true }
    if (action.type === "continue")
      return tracker.call(id, () => actions.send(key, "continue", { automatic: true }), settles)
    if (action.type === "stop") return tracker.call(id, () => actions.interrupt(key), settles)
    if (action.type === "nudge") {
      const terminal = actions.terminal(key)
      const sent = action.own ? undefined : { automatic: true as const }
      if (isTurnEntry(entry)) {
        if (!entry.stopped || !terminal || agentWorking(terminal))
          return tracker.fail(id, "That agent has moved on.")
        return tracker.call(
          id,
          async () => {
            await actions.send(key, action.text, sent)
            actions.forget([id])
          },
          settles,
        )
      }
      return tracker.call(
        id,
        async () => {
          if (terminal && agentWorking(terminal)) await actions.interrupt(key)
          await actions.send(key, action.text, sent)
        },
        settles,
      )
    }
    // Turning auto-resume on or off is for a backend that resumes agents.
  }
}
