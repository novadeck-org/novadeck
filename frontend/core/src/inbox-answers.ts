import { agentWorking } from "./agent-finish"
import type { ChatAnswer, ConversationKey } from "./conversation"
import type { InboxAnswer, InboxFinish, InboxItem, InboxState } from "./inbox"
import { reuse } from "./inbox-items"
import type { TerminalMetadata } from "./types"

// What a backend that builds its Inbox from the app's state does with the person's answers,
// the same for the runner and the demo: which items were seen, which answers are on their
// way, took, or failed, and what each kind of answer asks of the backend. The adapters keep
// only where their items and answers come from.

// Why an answer didn't take, as the person reads it.
export const answerFailure = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "That didn't take. Try again."

// The terminal an item is about, by its full address.
export const keyOf = ({ source }: InboxItem): ConversationKey => ({
  projectId: source.projectId,
  workspaceSessionId: source.workspaceSessionId,
  terminalId: source.terminalId,
})

// The finish an update stands for, as the app reads it.
export const finishOf = ({ source }: InboxItem): InboxFinish => ({
  context: `${source.projectId}/${source.workspaceSessionId}`,
  terminalId: source.terminalId,
})

// The state as it was when nothing changed in it, so what subscribes to it stays quiet.
export const keepInbox = (current: InboxState, next: InboxState): InboxState => {
  const items = reuse(current.items, next.items)
  return items === current.items &&
    JSON.stringify(next.answering) === JSON.stringify(current.answering) &&
    JSON.stringify(next.failed) === JSON.stringify(current.failed)
    ? current
    : { items, answering: next.answering, failed: next.failed }
}

// What the tracker shows of the items a backend found: the `seen` ones marked, and which
// are answering or have failed. A backend adds what it tracks itself before it publishes.
export type InboxView = {
  readonly items: readonly InboxItem[]
  readonly answering: Record<string, true>
  readonly failed: Record<string, string>
}

export type InboxTrackerOptions = {
  // How long an answer to trouble may leave its item standing before it can be answered
  // again.
  readonly settleMs: number
  // The tracker changed what the Inbox shows: the backend recomputes it.
  readonly changed: () => void
  // Keeps a call the backend waits for before it stops, as its other calls are.
  readonly track?: <T>(work: Promise<T>) => Promise<T>
}

export type InboxTracker = {
  readonly view: (found: readonly InboxItem[]) => InboxView
  readonly see: (id: string) => void
  // Runs an answer: its item shows answering until the backend drops it or the answer fails.
  // With `settles`, an answer that took but left its item standing (a prompt that started no
  // turn) gives the buttons back after `settleMs`. `onError` runs when the answer fails.
  readonly call: (
    id: string,
    work: () => Promise<unknown>,
    options?: { readonly settles?: boolean; readonly onError?: () => void },
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
  // What the person answered, until the item goes; and why an answer didn't take.
  const submitted = new Set<string>()
  const inFlight = new Set<string>()
  const failed = new Map<string, string>()
  // Per item, when its answer is given up on if the item still stands.
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
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
      const ids = new Set(found.map((item) => item.id))
      for (const id of seen) if (!ids.has(id)) seen.delete(id)
      for (const id of submitted) if (!ids.has(id) && !inFlight.has(id)) submitted.delete(id)
      const items = found.map((item) => (seen.has(item.id) ? { ...item, seen: true } : item))
      const answering: Record<string, true> = Object.fromEntries(
        [...inFlight].map((id) => [id, true]),
      )
      for (const item of items)
        if (submitted.has(item.id) || (item.kind === "request" && item.request.answered))
          answering[item.id] = true
      return { items, answering, failed: Object.fromEntries(failed) }
    },
    see: (id) => {
      if (seen.has(id)) return
      seen.add(id)
      changed()
    },
    call: (id, work, { settles = false, onError } = {}) => {
      clearTimeout(settling.get(id))
      settling.delete(id)
      failed.delete(id)
      submitted.add(id)
      inFlight.add(id)
      changed()
      const binds = round
      track(work()).then(
        () => {
          if (binds !== round) return
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
          if (binds !== round) return
          inFlight.delete(id)
          onError?.()
          fail(id, answerFailure(error))
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
      for (const known of [seen, inFlight, submitted, failed]) known.clear()
      round += 1
    },
    stop: () => {
      stop()
      round += 1
    },
  }
}

type RequestItem = Extract<InboxItem, { kind: "request" }>

// What answering an item asks of the backend; each is its own way to reach the agent.
export type InboxActions = {
  readonly request: (
    key: ConversationKey,
    item: RequestItem,
    answer: ChatAnswer,
  ) => Promise<unknown>
  readonly release: (thread: string) => void
  readonly stop: (thread: string) => void
  readonly read: (finishes: readonly InboxFinish[]) => void
  readonly send: (key: ConversationKey, text: string) => Promise<unknown>
  readonly interrupt: (key: ConversationKey) => Promise<unknown>
  // The item's terminal now, to see whether its agent works.
  readonly terminal: (key: ConversationKey) => TerminalMetadata | undefined
}

// Answers an item as its kind asks: a request through the agent's conversation, a held
// thread released or stopped, a finish read, trouble by continuing, stopping or nudging the
// agent (a nudge interrupts it first if it works). An answer of another kind fails; the
// kinds a backend answers itself (an ask, a told update) it handles before this.
export const answerItem = (
  tracker: InboxTracker,
  item: InboxItem,
  given: InboxAnswer,
  actions: InboxActions,
): void => {
  const { id } = item
  if (item.kind !== given.kind) return tracker.fail(id, "That answer isn't for this item.")
  const key = keyOf(item)
  if (item.kind === "request" && given.kind === "request")
    return tracker.call(id, () => actions.request(key, item, given.answer))
  if (item.kind === "held" && given.kind === "held") {
    tracker.forgive(id)
    const { threadId } = item.held
    if (given.action === "release") actions.release(threadId)
    else actions.stop(threadId)
    return
  }
  if (item.kind === "update" && given.kind === "update") {
    tracker.forgive(id)
    return actions.read([finishOf(item)])
  }
  if (item.kind === "trouble" && given.kind === "trouble") {
    const { action } = given
    const settles = { settles: true }
    if (action.type === "continue")
      return tracker.call(id, () => actions.send(key, "continue"), settles)
    if (action.type === "stop") return tracker.call(id, () => actions.interrupt(key), settles)
    if (action.type === "nudge") {
      const terminal = actions.terminal(key)
      return tracker.call(
        id,
        async () => {
          if (terminal && agentWorking(terminal)) await actions.interrupt(key)
          await actions.send(key, action.text)
        },
        settles,
      )
    }
    // Turning auto-resume on or off is for a backend that resumes agents.
  }
}
