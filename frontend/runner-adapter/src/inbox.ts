import type { ChatAnswer, ConversationKey } from "@novadeck/core/conversation"
import {
  emptyInbox,
  type Inbox,
  type InboxAnswer,
  type InboxBinding,
  type InboxFinish,
  type InboxRow,
  type InboxSource,
  type InboxState,
  type InboxTurn,
} from "@novadeck/core/inbox"
import {
  answerFailure,
  answerItem,
  createInboxTracker,
  isTurnRow,
  keepInbox,
  keyOf,
} from "@novadeck/core/inbox/answers"
import {
  dialogMs,
  inboxRows,
  type Asked,
  type InboxEntry as AskEntry,
} from "@novadeck/core/inbox/rows"
import type { MessagesState } from "@novadeck/core/messages"
import { createStore, type Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { longHoldMs, type AgentDetail, type AskAnswer, type InboxEntry } from "@novadeck/protocol"

import { requestOf } from "./conversations"

// The runner's Inbox: what every agent terminal waits on the person for, one item per
// terminal, built from what the UI already has: the terminals' statuses (a finished turn,
// its error, a usage limit), the messages held for release, and the requests of the agents
// that ask (read from `agents.detail`, opened only while one waits). Core's `inboxRows` is
// the pure derivation; `createRunnerInbox` keeps it current and answers through the runner.

// How long a terminal's detail stays open once nothing waits on it, so a request that
// comes straight after is not missed, and how soon a lost one is opened again.
export const detailGraceMs = 5000
export const retryMs = 1000
const retryCapMs = 10_000
const replyTrackingLimit = 1000
// How long an answer to trouble may leave its item standing before it can be answered again.
// Antigravity marks a turn's start at its first model call, which can take a while.
export const settleMs = 15_000

// The streams and calls the Inbox needs of the runner.
export type InboxStreams = {
  readonly inbox: {
    readonly watch: () => AsyncIterableIterator<InboxEntry[], undefined>
    readonly answer: (id: string, answer: AskAnswer) => Promise<void>
    readonly read: (ids: readonly string[]) => Promise<void>
    readonly dismiss: (id: string) => Promise<void>
    readonly clear: (ids: readonly string[]) => Promise<void>
  }
  readonly detail: (terminalId: string) => AsyncIterableIterator<AgentDetail, undefined>
  readonly answer: (key: ConversationKey, request: string, answer: ChatAnswer) => Promise<void>
  readonly send: (
    key: ConversationKey,
    text: string,
    options?: { readonly automatic?: true },
  ) => Promise<void>
  readonly interrupt: (key: ConversationKey) => Promise<string | null>
  // The messages' own, which track their progress in the messages state.
  readonly release: (thread: string) => void
  readonly stop: (thread: string) => void
}

export type RunnerInbox = Inbox & {
  readonly bind: NonNullable<Inbox["bind"]>
  readonly turns: NonNullable<Inbox["turns"]>
  readonly readFinishes: NonNullable<Inbox["readFinishes"]>
  // Ends every stream it opened; the backend is stopping.
  readonly end: () => void
}

type Reading = {
  alive: boolean
  requests: readonly Asked[]
  stream: AsyncIterableIterator<AgentDetail, undefined> | undefined
  closing: ReturnType<typeof setTimeout> | undefined
  retrying: ReturnType<typeof setTimeout> | undefined
  backoff: number
}

// The entries that are an ask, a tell or a done; a finished turn is `turnOf`.
type NotATurn = InboxEntry & { readonly content: AskEntry["content"] }
const notATurn = (entry: InboxEntry): entry is NotATurn => entry.content.kind !== "turn"

const turnOf = (entry: InboxEntry): InboxTurn | undefined => {
  const { content } = entry
  if (content.kind !== "turn") return undefined
  return {
    id: entry.id,
    projectId: entry.projectId,
    workspaceSessionId: entry.workspaceSessionId,
    terminalId: entry.terminalId,
    handle: entry.handle,
    agent: entry.agent,
    at: entry.at,
    outcome: content.outcome,
    reply: content.reply,
    error: content.error,
    files: content.files,
  }
}

const sameTurns = (
  a: readonly InboxTurn[] | undefined,
  b: readonly InboxTurn[] | undefined,
): boolean => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b))

const askedOf = (detail: AgentDetail): readonly Asked[] => {
  const root = detail.actors.find((actor) => actor.role === "root")?.ref ?? null
  return detail.requests.map((request) => ({
    request: requestOf(request, root),
    askedAt: request.askedAt,
  }))
}

export const createRunnerInbox = (
  streams: InboxStreams,
  messages: Store<MessagesState>,
  {
    now = Date.now,
    // Keeps a call the backend waits for before it stops, as its other calls are.
    track = (work) => work,
  }: {
    now?: () => number
    track?: <T>(work: Promise<T>) => Promise<T>
  } = {},
): RunnerInbox => {
  const state = createStore<InboxState>(emptyInbox)
  let binding: InboxBinding | null = null
  // Asks and tells, as the runner last listed them, and its finished turns (undefined until
  // the first listing, and after the listing ended for good).
  let entries: readonly NotATurn[] = []
  let listed: readonly InboxTurn[] | undefined
  const turns = createStore<readonly InboxTurn[] | undefined>(undefined)
  // The turn rows read on the person's looking: out of `turns` at once, until a listing no
  // longer holds them. `inflight` the ones whose read is on its way; `queued` the ones to
  // send at the end of this tick.
  const hidden = new Set<string>()
  const inflight = new Set<string>()
  let queued: string[] = []
  let readRetry: ReturnType<typeof setTimeout> | undefined
  let backoff = retryMs
  let entriesStream: AsyncIterableIterator<InboxEntry[], undefined> | undefined
  const stopEntries = (): void => {
    const stream = entriesStream
    entriesStream = undefined
    entries = []
    forgetTurns()
    void stream?.return?.()?.catch?.(() => {})
  }
  const forgetTurns = (): void => {
    listed = undefined
    hidden.clear()
    inflight.clear()
    queued = []
    clearTimeout(readRetry)
    readRetry = undefined
    backoff = retryMs
  }
  let unsubscribe: (() => void)[] = []
  const readings = new Map<string, Reading>()
  // What the person answered, what failed, and when an answer is given up on.
  const tracker = createInboxTracker({ settleMs, changed: () => recompute(), track })
  // Keep recent replies until delivery is known, their terminal closes or observed history goes.
  const replies = new Map<
    string,
    { readonly thread: string; readonly source: InboxSource; readonly observed: boolean }
  >()
  // Set once the backend stops: nothing opens or recomputes after it.
  let ended = false

  const close = (id: string): void => {
    const reading = readings.get(id)
    if (!reading) return
    readings.delete(id)
    reading.alive = false
    clearTimeout(reading.closing)
    clearTimeout(reading.retrying)
    const { stream } = reading
    reading.stream = undefined
    void stream?.return?.()?.catch?.(() => {})
  }

  const connect = (id: string, reading: Reading): void => {
    if (ended) return
    let stream: AsyncIterableIterator<AgentDetail, undefined>
    try {
      stream = streams.detail(id)
    } catch {
      return retry(id, reading)
    }
    reading.stream = stream
    void (async () => {
      try {
        for await (const snapshot of stream) {
          if (!reading.alive || reading.stream !== stream) return
          reading.requests = askedOf(snapshot)
          reading.backoff = retryMs
          recompute()
        }
      } catch {
        // The terminal is gone, or the runner is: opened again while something waits on it.
      }
      if (!reading.alive || reading.stream !== stream) return
      reading.stream = undefined
      retry(id, reading)
    })()
  }

  const retry = (id: string, reading: Reading): void => {
    reading.retrying = setTimeout(() => {
      reading.retrying = undefined
      if (reading.alive) connect(id, reading)
    }, reading.backoff)
    reading.backoff = Math.min(reading.backoff * 2, retryCapMs)
  }

  // Details stay open for the terminals whose agent has a request waiting, and a while
  // after.
  const follow = (workspace: Workspace): void => {
    const waiting = new Set<string>()
    for (const project of workspace.projects)
      for (const session of project.history)
        for (const terminal of session.state.roster.terminals)
          if (terminal.state === "running" && terminal.agent?.attention) waiting.add(terminal.id)
    for (const id of waiting) {
      const known = readings.get(id)
      if (known) {
        clearTimeout(known.closing)
        known.closing = undefined
        continue
      }
      const reading: Reading = {
        alive: true,
        requests: [],
        stream: undefined,
        closing: undefined,
        retrying: undefined,
        backoff: retryMs,
      }
      readings.set(id, reading)
      connect(id, reading)
    }
    for (const [id, reading] of readings)
      if (!waiting.has(id) && reading.closing === undefined)
        reading.closing = setTimeout(() => {
          close(id)
          recompute()
        }, detailGraceMs)
  }

  // Sends the reads of turn rows, a thousand ids at a time. A failed one is tried again with
  // the next listing, or after a backoff, never because of its own change.
  const sendReads = (ids: readonly string[]): void => {
    const next = binding
    if (!next || ended) return
    const fresh = ids.filter((id) => !inflight.has(id))
    for (let start = 0; start < fresh.length; start += 1000) {
      const batch = fresh.slice(start, start + 1000)
      for (const id of batch) inflight.add(id)
      track(Promise.resolve().then(() => streams.inbox.read(batch))).then(
        () => {
          if (binding !== next) return
          for (const id of batch) inflight.delete(id)
          backoff = retryMs
        },
        () => {
          if (binding !== next) return
          for (const id of batch) inflight.delete(id)
          clearTimeout(readRetry)
          readRetry = setTimeout(() => {
            readRetry = undefined
            retryReads()
          }, backoff)
          backoff = Math.min(backoff * 2, retryCapMs)
        },
      )
    }
  }

  // Sends again the reads that are still listed and not on their way.
  const retryReads = (): void => {
    if (!listed) return
    const held = new Set(listed.map(({ id }) => id))
    sendReads([...hidden].filter((id) => held.has(id)))
  }

  // Hides turn rows at once and reads them; a row already hidden is left to its retry.
  const hide = (ids: readonly string[]): void => {
    const fresh = ids.filter((id) => !hidden.has(id))
    if (fresh.length === 0) return
    for (const id of fresh) hidden.add(id)
    if (queued.length === 0)
      queueMicrotask(() => {
        const send = queued
        queued = []
        sendReads(send)
      })
    queued.push(...fresh)
    recompute()
  }

  // A change that a subscriber to `turns` answers with a read (the UI's view-read) recomputes
  // inside this one: it is run again after, not nested, so what publishes is the latest.
  let computing = false
  let dirty = false
  const recompute = (): void => {
    if (computing) {
      dirty = true
      return
    }
    computing = true
    try {
      do {
        dirty = false
        compute()
      } while (dirty)
    } finally {
      computing = false
    }
  }

  const compute = (): void => {
    if (!binding || ended) return
    const workspace = binding.workspace.getSnapshot()
    const visible = listed?.filter(({ id }) => !hidden.has(id))
    if (!sameTurns(turns.getSnapshot(), visible)) turns.update(() => visible)
    follow(workspace)
    const requests = Object.fromEntries(
      [...readings].map(([id, reading]) => [id, reading.requests] as const),
    )
    const at = now()
    const found = inboxRows({
      workspace,
      turns: visible ?? [],
      messages: messages.getSnapshot(),
      entries,
      requests,
      now: at,
      longHoldMs,
    })
    const { items, answering, failed: shown } = tracker.view(found)

    // A held thread's release or stop is tracked with the messages, so a pane's counts too.
    const { releasing, failed: refused } = messages.getSnapshot()
    const rest: Record<string, string> = shown
    const threads = new Map(
      Object.values(messages.getSnapshot().terminals).flatMap((listing) =>
        listing.threads.map((thread) => [thread.id, thread] as const),
      ),
    )
    for (const [id, reply] of replies) {
      const history = threads.get(reply.thread)
      const lost = history?.messages.some(
        (message) =>
          message.inboxState === "undelivered" ||
          (message.inbox === "answer" && message.state === "gone" && message.deliveredAt === null),
      )
      if (
        history?.messages.some(
          (message) => message.inbox === "answer" && message.state === "delivered",
        )
      ) {
        replies.delete(id)
      } else if (lost || !terminalOf(reply.source)) {
        const message = "Your reply was not delivered because the agent's session ended."
        tracker.note(id, message)
        rest[id] = message
        replies.delete(id)
      } else if (!history && reply.observed) {
        replies.delete(id)
      } else if (history && !reply.observed) {
        replies.set(id, { ...reply, observed: true })
      }
    }
    for (const item of items)
      if (item.kind === "held") {
        const thread = item.held.threadId
        if (releasing[thread]) answering[item.id] = true
        if (refused[thread]) rest[item.id] = refused[thread]
      }
    state.update((current) => keepInbox(current, { items, answering, failed: rest }))

    // A request whose dialog is unread shows anyway once it has waited long enough, and a
    // hold once it has held long enough.
    tracker.wake([
      ...Object.values(requests)
        .flat()
        .filter(({ request }) => request.dialog === null)
        .map(({ askedAt }) => askedAt + dialogMs - at),
      ...Object.values(messages.getSnapshot().terminals).map(({ waitsSince }) =>
        waitsSince == null ? 0 : waitsSince + longHoldMs - at,
      ),
    ])
  }

  const find = (id: string): InboxRow | undefined =>
    state.getSnapshot().items.find((item) => item.id === id)

  const terminalOf = (source: InboxSource): TerminalMetadata | undefined =>
    binding?.workspace
      .getSnapshot()
      .projects.find((project) => project.id === source.projectId)
      ?.history.find((session) => session.id === source.workspaceSessionId)
      ?.state.roster.terminals.find((terminal) => terminal.id === source.terminalId)

  const answer = (id: string, given: InboxAnswer): void => {
    const item = find(id)
    // A settled ask is no longer the agent's to be answered.
    if (!item || item.settled || !binding || state.getSnapshot().answering[id]) return
    const key = keyOf(item)
    if (item.kind === "ask" && given.kind === "ask") {
      replies.delete(id)
      replies.set(id, {
        thread: `t-${id.replaceAll("-", "")}`,
        source: item.source,
        observed: false,
      })
      if (replies.size > replyTrackingLimit) replies.delete(replies.keys().next().value!)
      return tracker.call(id, () => streams.inbox.answer(id, given.answer), {
        onError: () => replies.delete(id),
      })
    }
    if (
      item.kind === "update" &&
      given.kind === "update" &&
      (item.update.type === "told" || item.update.type === "done")
    )
      return tracker.call(id, () => streams.inbox.read([id]))
    answerItem(tracker, item, given, {
      request: (_, { request }, chat) => streams.answer(key, request.id, chat),
      release: (thread) => streams.release(thread),
      stop: (thread) => streams.stop(thread),
      read: (ids) => {
        for (const each of ids) tracker.call(each, () => streams.inbox.read([each]))
      },
      forget: hide,
      send: (at, text, options) => streams.send(at, text, options),
      interrupt: (at) => streams.interrupt(at),
      terminal: () => terminalOf(item.source),
    })
  }

  return {
    state,
    answer,
    see: (id) => {
      if (find(id)) tracker.see(id)
    },
    turns,
    readFinishes: (finishes: readonly InboxFinish[]) => {
      if (!listed) return
      const wanted = new Set(finishes.map(({ context, terminalId }) => `${context}/${terminalId}`))
      hide(
        listed
          .filter((row) =>
            wanted.has(`${row.projectId}/${row.workspaceSessionId}/${row.terminalId}`),
          )
          .map(({ id }) => id),
      )
    },
    dismiss: (id) => {
      const item = find(id)
      // Only an open Novadeck ask: a harness's own question is answered in its dialog.
      if (
        !item ||
        item.kind !== "ask" ||
        item.settled ||
        !binding ||
        state.getSnapshot().answering[id]
      )
        return
      tracker.call(id, () => streams.inbox.dismiss(id), { silent: true })
    },
    clear: (ids) => {
      const settled = new Set(
        state
          .getSnapshot()
          .items.filter((item) => item.kind === "ask" && item.settled)
          .map((item) => item.id),
      )
      const wanted = ids.filter((id) => settled.has(id))
      if (wanted.length === 0) return
      const live = tracker.guard()
      for (let start = 0; start < wanted.length; start += 1000) {
        const batch = wanted.slice(start, start + 1000)
        track(Promise.resolve().then(() => streams.inbox.clear(batch))).catch((error: unknown) => {
          if (!live()) return
          for (const id of batch) tracker.fail(id, answerFailure(error))
        })
      }
    },
    readAll: () => {
      // The updates and the failed rows that only inform, as shown.
      const ids = state
        .getSnapshot()
        .items.filter((item) => item.kind === "update" || (isTurnRow(item) && !item.stopped))
        .map(({ id }) => id)
      if (ids.length === 0) return
      tracker.submit(ids)
      recompute()
      const live = tracker.guard()
      for (let start = 0; start < ids.length; start += 1000) {
        const batch = ids.slice(start, start + 1000)
        track(Promise.resolve().then(() => streams.inbox.read(batch))).catch((error: unknown) => {
          if (!live()) return
          for (const id of batch) tracker.fail(id, answerFailure(error))
        })
      }
    },
    bind: (next) => {
      binding = next
      unsubscribe = [next.workspace.subscribe(recompute), messages.subscribe(recompute)]
      stopEntries()
      const stream = streams.inbox.watch()
      entriesStream = stream
      void (async () => {
        try {
          for await (const snapshot of stream) {
            if (entriesStream !== stream || binding !== next || ended) return
            entries = snapshot.filter(notATurn)
            listed = snapshot.flatMap((entry) => turnOf(entry) ?? [])
            const held = new Set(listed.map(({ id }) => id))
            for (const id of hidden) if (!held.has(id)) hidden.delete(id)
            recompute()
            retryReads()
          }
        } catch {
          // The client reconnects subscriptions; a permanently closed stream drops its entries.
        }
        if (entriesStream !== stream) return
        entriesStream = undefined
        entries = []
        forgetTurns()
        recompute()
      })()
      recompute()
      return () => {
        if (binding !== next) return
        stopEntries()
        binding = null
        for (const stop of unsubscribe) stop()
        unsubscribe = []
        tracker.reset()
        for (const id of readings.keys()) close(id)
        replies.clear()
        turns.update(() => undefined)
        state.update(() => emptyInbox)
      }
    },
    end: () => {
      ended = true
      stopEntries()
      tracker.stop()
      for (const id of readings.keys()) close(id)
    },
  }
}
