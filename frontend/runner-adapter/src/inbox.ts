import { agentWorking } from "@novadeck/core/agent-finish"
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
import { dialogMs, inboxItems, reuse, type Asked } from "@novadeck/core/inbox-items"
import type { MailState } from "@novadeck/core/messages"
import { createStore, type Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import type { AgentDetail, AskAnswer, InboxLetter } from "@novadeck/protocol"
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

const reason = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "That didn't take. Try again."

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
  const seen = new Set<string>()
  // What the person answered, until the item goes; and why an answer didn't take.
  const submitted = new Set<string>()
  const inFlight = new Set<string>()
  // Keep recent replies until delivery is known, their terminal closes or observed history goes.
  const replies = new Map<
    string,
    { readonly thread: string; readonly source: InboxSource; readonly observed: boolean }
  >()
  const failed = new Map<string, string>()
  let due: ReturnType<typeof setTimeout> | undefined
  // Per item, when its answer is given up on if the item still stands.
  const settling = new Map<string, ReturnType<typeof setTimeout>>()
  const clearSettling = (): void => {
    for (const timer of settling.values()) clearTimeout(timer)
    settling.clear()
  }
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
    })
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

    // A held thread's release or stop is tracked with the messages, so a pane's counts too.
    const { releasing, failed: refused } = mail.getSnapshot()
    const rest: Record<string, string> = Object.fromEntries(failed)
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
        failed.set(id, message)
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
    state.update((current) => {
      const kept = reuse(current.items, items)
      return kept === current.items &&
        JSON.stringify(answering) === JSON.stringify(current.answering) &&
        JSON.stringify(rest) === JSON.stringify(current.failed)
        ? current
        : { items: kept, answering, failed: rest }
    })

    // A request whose dialog is unread shows anyway once it has waited long enough.
    clearTimeout(due)
    due = undefined
    const waits = Object.values(requests)
      .flat()
      .filter(({ request }) => request.dialog === null)
      .map(({ askedAt }) => askedAt + dialogMs - at)
      .filter((wait) => wait > 0)
    if (waits.length > 0) due = setTimeout(recompute, Math.min(...waits))
  }

  const find = (id: string): InboxItem | undefined =>
    state.getSnapshot().items.find((item) => item.id === id)

  const fail = (id: string, message: string): void => {
    submitted.delete(id)
    failed.set(id, message)
    recompute()
  }

  const terminalOf = (source: InboxSource): TerminalMetadata | undefined =>
    binding?.workspace
      .getSnapshot()
      .projects.find((project) => project.id === source.projectId)
      ?.history.find((session) => session.id === source.workspaceSessionId)
      ?.state.roster.terminals.find((terminal) => terminal.id === source.terminalId)

  // Runs an answer. With `settles`, an answer that took but left its item standing (a
  // prompt that started no turn) gives the buttons back after a few seconds.
  const call = (id: string, work: () => Promise<unknown>, settles = false): void => {
    clearTimeout(settling.get(id))
    settling.delete(id)
    failed.delete(id)
    submitted.add(id)
    inFlight.add(id)
    recompute()
    track(work()).then(
      () => {
        inFlight.delete(id)
        recompute()
        if (!settles) return
        settling.set(
          id,
          setTimeout(() => {
            settling.delete(id)
            if (!submitted.delete(id)) return
            recompute()
          }, settleMs),
        )
      },
      (error: unknown) => {
        inFlight.delete(id)
        replies.delete(id)
        fail(id, reason(error))
      },
    )
  }

  const answer = (id: string, given: InboxAnswer): void => {
    const item = find(id)
    if (!item || !binding || state.getSnapshot().answering[id]) return
    if (item.kind !== given.kind) return fail(id, "That answer isn't for this item.")
    const key: ConversationKey = {
      projectId: item.source.projectId,
      workspaceSessionId: item.source.workspaceSessionId,
      terminalId: item.source.terminalId,
    }
    if (item.kind === "request" && given.kind === "request")
      return call(id, () => streams.answer(key, item.request.id, given.answer))
    if (item.kind === "held" && given.kind === "held") {
      failed.delete(id)
      const { threadId } = item.held
      if (given.action === "release") streams.release(threadId)
      else streams.stop(threadId)
      return
    }
    if (item.kind === "ask" && given.kind === "ask") {
      replies.delete(id)
      replies.set(id, {
        thread: `t-${id.replaceAll("-", "")}`,
        source: item.source,
        observed: false,
      })
      if (replies.size > replyTrackingLimit) replies.delete(replies.keys().next().value!)
      return call(id, () => streams.asks.answer(id, given.answer))
    }
    if (item.kind === "update" && given.kind === "update") {
      if (item.update.type === "told") return call(id, () => streams.asks.read([id]))
      failed.delete(id)
      return binding.read([
        {
          context: `${item.source.projectId}/${item.source.workspaceSessionId}`,
          terminalId: key.terminalId,
        },
      ])
    }
    if (item.kind === "trouble" && given.kind === "trouble") {
      const { action } = given
      if (action.type === "continue") return call(id, () => streams.send(key, "continue"), true)
      if (action.type === "stop") return call(id, () => streams.interrupt(key), true)
      if (action.type === "nudge") {
        const terminal = terminalOf(item.source)
        return call(
          id,
          async () => {
            if (terminal && agentWorking(terminal)) await streams.interrupt(key)
            await streams.send(key, action.text)
          },
          true,
        )
      }
      // Novadeck resumes no agent in this backend: nothing to turn on or off.
    }
  }

  return {
    state,
    answer,
    see: (id) => {
      if (seen.has(id) || !find(id)) return
      seen.add(id)
      recompute()
    },
    readAll: () => {
      // Include told updates hidden by a more urgent item on the same terminal.
      const tells = letters.filter((letter) => letter.content.kind === "tell").map(({ id }) => id)
      if (tells.length > 0) {
        for (const id of tells) submitted.add(id)
        recompute()
        for (let start = 0; start < tells.length; start += 1000) {
          const batch = tells.slice(start, start + 1000)
          track(streams.asks.read(batch)).catch((error: unknown) => {
            for (const id of batch) fail(id, reason(error))
          })
        }
      }
      const updates = state
        .getSnapshot()
        .items.filter((item) => item.kind === "update" && item.update.type === "finished")
      if (updates.length > 0 && binding)
        binding.read(
          updates.map((item) => ({
            context: `${item.source.projectId}/${item.source.workspaceSessionId}`,
            terminalId: item.source.terminalId,
          })),
        )
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
        clearTimeout(due)
        clearSettling()
        for (const id of readings.keys()) close(id)
        seen.clear()
        submitted.clear()
        inFlight.clear()
        replies.clear()
        failed.clear()
        state.update(() => emptyInbox)
      }
    },
    end: () => {
      ended = true
      stopLetters()
      clearTimeout(due)
      clearSettling()
      for (const id of readings.keys()) close(id)
    },
  }
}
