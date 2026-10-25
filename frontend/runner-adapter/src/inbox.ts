import type { ChatAnswer, ConversationKey } from "@novadeck/core/conversation"
import {
  emptyInbox,
  type Inbox,
  type InboxAnswer,
  type InboxBinding,
  type InboxItem,
  type InboxSource,
  type InboxState,
} from "@novadeck/core/inbox"
import {
  answerFailure,
  answerItem,
  createInboxTracker,
  finishOf,
  keepInbox,
  keyOf,
} from "@novadeck/core/inbox-answers"
import { dialogMs, inboxItems, type Asked } from "@novadeck/core/inbox-items"
import type { MailState } from "@novadeck/core/messages"
import { createStore, type Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { longHoldMs, type AgentDetail, type AskAnswer, type InboxLetter } from "@novadeck/protocol"
import { currentPlatform } from "@novadeck/terminal-views/platform"

import { requestOf } from "./conversations"

// The runner's Inbox: what every agent terminal waits on the person for, one item per
// terminal, built from what the UI already has: the terminals' statuses (a finished turn,
// its error, a usage limit), the messages held for release, and the requests of the agents
// that ask (read from `agents.detail`, opened only while one waits). Core's `inboxItems` is
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
  readonly asks: {
    readonly watch: () => AsyncIterableIterator<InboxLetter[], undefined>
    readonly answer: (id: string, answer: AskAnswer) => Promise<void>
    readonly read: (ids: readonly string[]) => Promise<void>
  }
  readonly detail: (terminalId: string) => AsyncIterableIterator<AgentDetail, undefined>
  readonly answer: (key: ConversationKey, request: string, answer: ChatAnswer) => Promise<void>
  readonly send: (key: ConversationKey, text: string) => Promise<void>
  readonly interrupt: (key: ConversationKey) => Promise<string | null>
  // The messages' own, which track their progress in the mail state.
  readonly release: (thread: string) => void
  readonly stop: (thread: string) => void
}

export type RunnerInbox = Inbox & {
  readonly bind: NonNullable<Inbox["bind"]>
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

const askedOf = (detail: AgentDetail): readonly Asked[] => {
  const root = detail.actors.find((actor) => actor.role === "root")?.ref ?? null
  return detail.requests.map((request) => ({
    request: requestOf(request, root),
    askedAt: request.askedAt,
  }))
}

export const createRunnerInbox = (
  streams: InboxStreams,
  mail: Store<MailState>,
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
  let letters: readonly InboxLetter[] = []
  let lettersStream: AsyncIterableIterator<InboxLetter[], undefined> | undefined
  const stopLetters = (): void => {
    const stream = lettersStream
    lettersStream = undefined
    letters = []
    void stream?.return?.()?.catch?.(() => {})
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

  const recompute = (): void => {
    if (!binding || ended) return
    const workspace = binding.workspace.getSnapshot()
    follow(workspace)
    const requests = Object.fromEntries(
      [...readings].map(([id, reading]) => [id, reading.requests] as const),
    )
    const at = now()
    const found = inboxItems({
      workspace,
      unread: binding.unread.getSnapshot(),
      mail: mail.getSnapshot(),
      letters,
      requests,
      now: at,
      caseless: currentPlatform() === "mac",
      longHoldMs,
    })
    const { items, answering, failed: shown } = tracker.view(found)

    // A held thread's release or stop is tracked with the messages, so a pane's counts too.
    const { releasing, failed: refused } = mail.getSnapshot()
    const rest: Record<string, string> = shown
    const threads = new Map(
      Object.values(mail.getSnapshot().terminals).flatMap((listing) =>
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
      ...Object.values(mail.getSnapshot().terminals).map(({ waitsSince }) =>
        waitsSince == null ? 0 : waitsSince + longHoldMs - at,
      ),
    ])
  }

  const find = (id: string): InboxItem | undefined =>
    state.getSnapshot().items.find((item) => item.id === id)

  const terminalOf = (source: InboxSource): TerminalMetadata | undefined =>
    binding?.workspace
      .getSnapshot()
      .projects.find((project) => project.id === source.projectId)
      ?.history.find((session) => session.id === source.workspaceSessionId)
      ?.state.roster.terminals.find((terminal) => terminal.id === source.terminalId)

  const answer = (id: string, given: InboxAnswer): void => {
    const item = find(id)
    if (!item || !binding || state.getSnapshot().answering[id]) return
    const key = keyOf(item)
    if (item.kind === "ask" && given.kind === "ask") {
      replies.delete(id)
      replies.set(id, {
        thread: `t-${id.replaceAll("-", "")}`,
        source: item.source,
        observed: false,
      })
      if (replies.size > replyTrackingLimit) replies.delete(replies.keys().next().value!)
      return tracker.call(id, () => streams.asks.answer(id, given.answer), {
        onError: () => replies.delete(id),
      })
    }
    if (item.kind === "update" && given.kind === "update" && item.update.type === "told")
      return tracker.call(id, () => streams.asks.read([id]))
    const { read } = binding
    answerItem(tracker, item, given, {
      request: (_, { request }, chat) => streams.answer(key, request.id, chat),
      release: (thread) => streams.release(thread),
      stop: (thread) => streams.stop(thread),
      read,
      send: (at, text) => streams.send(at, text),
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
    readAll: () => {
      const tells = letters.filter((letter) => letter.content.kind === "tell").map(({ id }) => id)
      if (tells.length > 0) {
        tracker.submit(tells)
        recompute()
        const live = tracker.guard()
        for (let start = 0; start < tells.length; start += 1000) {
          const batch = tells.slice(start, start + 1000)
          track(streams.asks.read(batch)).catch((error: unknown) => {
            if (!live()) return
            for (const id of batch) tracker.fail(id, answerFailure(error))
          })
        }
      }
      const updates = state
        .getSnapshot()
        .items.filter((item) => item.kind === "update" && item.update.type === "finished")
      if (updates.length > 0 && binding) binding.read(updates.map(finishOf))
    },
    bind: (next) => {
      binding = next
      unsubscribe = [
        next.workspace.subscribe(recompute),
        next.unread.subscribe(recompute),
        mail.subscribe(recompute),
      ]
      stopLetters()
      const stream = streams.asks.watch()
      lettersStream = stream
      void (async () => {
        try {
          for await (const snapshot of stream) {
            if (lettersStream !== stream || binding !== next || ended) return
            letters = snapshot
            recompute()
          }
        } catch {
          // The client reconnects subscriptions; a permanently closed stream drops its letters.
        }
        if (lettersStream !== stream) return
        lettersStream = undefined
        letters = []
        recompute()
      })()
      recompute()
      return () => {
        if (binding !== next) return
        stopLetters()
        binding = null
        for (const stop of unsubscribe) stop()
        unsubscribe = []
        tracker.reset()
        for (const id of readings.keys()) close(id)
        replies.clear()
        state.update(() => emptyInbox)
      }
    },
    end: () => {
      ended = true
      stopLetters()
      tracker.stop()
      for (const id of readings.keys()) close(id)
    },
  }
}
