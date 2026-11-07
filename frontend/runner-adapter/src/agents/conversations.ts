import {
  noConversation,
  type ChatAction,
  type ChatAnswer,
  type ChatBox,
  type ChatDialog,
  type ChatItem,
  type ChatPrompt,
  type ChatRequest,
  conflictFailure,
  notCleared,
  SettleInTerminal,
  withReturned,
  WordsLost,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
import { promptRefusal } from "@novadeck/core/conversation/prompt-refusal"
import { createStore, type MutableStore, type Store } from "@novadeck/core/store"
import {
  conflictReason,
  normalisedText,
  promptFailure,
  promptRefusal as protocolRefusal,
  type AgentDetail,
  type SliceChange,
  type RequestAnswer,
  type TranscriptChange,
  type TranscriptItem,
} from "@novadeck/protocol"
import { hasCode } from "@novadeck/runner-client"

// The runner's conversations: each terminal's agent as `agents.detail` follows it, and
// the root agent's transcript as `agents.transcript` streams it. Reading a terminal
// starts with its first subscriber and stops a while after its last leaves, so
// switching views or sessions doesn't start it over; stopping always ends both streams.

export type ConversationStreams = {
  readonly detail: (terminalId: string) => AsyncIterableIterator<AgentDetail, undefined>
  readonly slice: (terminalId: string) => AsyncIterableIterator<SliceChange, undefined>
  readonly transcript: (
    terminalId: string,
    actor: string,
  ) => AsyncIterableIterator<TranscriptChange, undefined>
  readonly prompt: (
    terminalId: string,
    text: string,
    options?: { readonly automatic?: true; readonly along?: true; readonly ref?: string },
  ) => Promise<{
    readonly ref: string
    readonly tracked: boolean
    readonly returned?: string | null | undefined
  }>
  readonly interrupt: (terminalId: string) => Promise<{ readonly returned: string | null }>
  readonly keys: (terminalId: string, keys: string) => Promise<void>
  readonly takeBox: (terminalId: string) => Promise<{ readonly returned: string | null }>
  readonly putBox: (terminalId: string, text: string) => Promise<{ readonly placed: boolean }>
  readonly answer: (terminalId: string, request: string, answer: RequestAnswer) => Promise<void>
}

export type RunnerConversations = Conversations & {
  // Stops reading every terminal at once.
  readonly stop: () => void
}

// How long Enter waits behind the keys before it, in milliseconds: Codex reads an Enter right
// behind text as part of a paste, and puts a line break in its box.
export const enterGapMs = 150

// How long a terminal keeps being read after its last subscriber left, in milliseconds.
export const graceMs = 30_000

// How long a read again after a reset may be quiet before it replaces what shows, in
// milliseconds.
export const settleMs = 500

// How long a transcript may be open without a batch before it counts as read: the runner
// sends none for a session whose file is empty, and goes on following it, in milliseconds.
export const loadedMs = 1000

// How long a read that failed waits before it asks again, doubling with each failure up to the
// longest, in milliseconds.
export const retryMs = 1000
export const retryMaxMs = 15_000

// How many failed reads in a row it takes for a conversation that showed nothing to count as
// read: until then it is loading, as the runner may not yet know where the transcript is.
export const failuresToLoaded = 3

type Stream<T> = AsyncIterableIterator<T, undefined>

const end = (stream: Stream<unknown> | undefined): void => {
  void stream?.return?.()?.catch?.(() => {})
}

const itemOf = (session: string, item: TranscriptItem): ChatItem => ({
  id: `${session}:${item.index}`,
  at: item.at,
  role: item.role,
  kind: item.kind,
  text: item.text,
  truncated: item.truncated,
  tool: item.tool,
  call: item.call,
  author: item.author,
  run: item.run,
  outcome: item.outcome,
  scripted: item.scripted,
  interrupted: item.interrupted,
})

// The items once a batch arrived: each item at an index replaces everything from there on.
export const withBatch = (
  items: readonly ChatItem[],
  session: string,
  batch: readonly TranscriptItem[],
): readonly ChatItem[] => {
  const next = [...items]
  for (const item of batch) {
    if (item.index < next.length) next.length = item.index
    next.push(itemOf(session, item))
  }
  return next
}

// The root agent's ref in the agent's detail, or null before it has one.
export const rootOf = (detail: AgentDetail): string | null =>
  detail.actors.find((actor) => actor.role === "root")?.ref ?? null

// A request of the agent's detail, as the chat has it; `root` is the root agent's ref.
export const requestOf = (
  request: AgentDetail["requests"][number],
  root: string | null,
): ChatRequest => ({
  id: request.ref,
  kind: request.kind,
  tool: request.tool,
  subject: request.subject,
  choices: request.choices,
  subagent: request.actor !== root,
  dialog: request.dialog,
  answered: request.answered,
})

const requestsOf = (detail: AgentDetail, root: string | null): readonly ChatRequest[] =>
  detail.requests.map((request) => requestOf(request, root))

// The receipts of the prompts given in the session, as the chat has them. A settled one
// keeps the words its receipt carried while pending, as the runner drops them, so the chat
// can show it until its item arrives.
const promptsOf = (detail: AgentDetail, before: readonly ChatPrompt[]): readonly ChatPrompt[] =>
  (detail.prompts ?? []).map(({ ref, text, sentAt, state, item }) => ({
    ref,
    text:
      text ??
      (state === "settled" ? (before.find((prompt) => prompt.ref === ref)?.text ?? null) : null),
    sentAt,
    state,
    item,
  }))

const samePrompts = (a: readonly ChatPrompt[], b: readonly ChatPrompt[]): boolean =>
  a.length === b.length &&
  a.every(
    (prompt, index) =>
      prompt.ref === b[index]!.ref &&
      prompt.text === b[index]!.text &&
      prompt.sentAt === b[index]!.sentAt &&
      prompt.state === b[index]!.state &&
      prompt.item === b[index]!.item,
  )

const sameBox = (a: ChatBox | null, b: ChatBox | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.text === b.text &&
    a.mode === b.mode &&
    a.tail === b.tail &&
    a.known === b.known)

// Dialogs are plain data a snapshot sends again whole, so they are the same when they read
// the same.
const sameDialog = (a: ChatDialog | null, b: ChatDialog | null): boolean =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b))

const sameRequests = (a: readonly ChatRequest[], b: readonly ChatRequest[]): boolean =>
  a.length === b.length &&
  a.every(
    (request, index) =>
      request.id === b[index]!.id &&
      request.kind === b[index]!.kind &&
      request.tool === b[index]!.tool &&
      request.subject === b[index]!.subject &&
      request.subagent === b[index]!.subagent &&
      request.answered === b[index]!.answered &&
      request.choices.length === b[index]!.choices.length &&
      request.choices.every((choice, at) => choice === b[index]!.choices[at]) &&
      sameDialog(request.dialog, b[index]!.dialog),
  )

// The runner's own words for why it refused, where it gave any beyond its code.
const said = (error: unknown): string | undefined =>
  error instanceof Error &&
  error.message.trim() !== "" &&
  error.message !== (error as { code?: unknown }).code
    ? error.message
    : undefined

// Why the runner says a CONFLICT is one, where it says and this client knows the reason.
const conflictReasonOf = (error: { readonly data: unknown }) =>
  conflictReason.safeParse(error.data).data?.reason

// The words a prompt took out of the agent's box before it failed, where it says.
const wordsOf = (error: { readonly data: unknown }) =>
  promptFailure.safeParse(error.data).data?.returned

// What the person is told when the agent can't take what they sent.
const failure = (error: unknown, what: string, action: ChatAction): Error => {
  if (hasCode(error, "DISCONNECTED", "CLOSED")) return new Error("The runner is offline.")
  // Refused before anything was written: the text has a shape the agent reads as more than
  // a message, or the agent can't take one now, for the reason the runner gives.
  if (hasCode(error, "PROMPT_REFUSED")) return new Error(said(error) ?? promptRefusal)
  if (hasCode(error, "CONFLICT"))
    return withReturned(conflictFailure(conflictReasonOf(error), action), wordsOf(error))
  // Stopped, but the words queued behind the turn stay in the agent's own box.
  if (hasCode(error, "BOX_NOT_CLEARED")) return notCleared()
  if (hasCode(error, "PROMPT_FAILED"))
    return withReturned(
      new SettleInTerminal(
        "The prompt didn't land in the agent's box. It may be there as a draft.",
      ),
      wordsOf(error),
    )
  return new Error(`Couldn't ${what} the agent.`)
}

// The protocol's answer for the chat's, whose lists are read-only.
const requestAnswerOf = (answer: ChatAnswer): RequestAnswer => {
  if (answer.type === "choice") return { ...answer }
  if (answer.type === "chat") return { ...answer }
  if (answer.type === "form") return { ...answer, values: { ...answer.values } }
  return {
    type: "questions",
    dialog: answer.dialog,
    answers: answer.answers.map((each) => ({ ...each, options: [...each.options] })),
  }
}

// What the person is told when a request couldn't be answered.
const refusal = (error: unknown): Error => {
  if (hasCode(error, "DISCONNECTED", "CLOSED")) return new Error("The runner is offline.")
  if (hasCode(error, "PROMPT_REFUSED")) return new Error(said(error) ?? promptRefusal)
  if (hasCode(error, "DIALOG_CHANGED"))
    return new Error("The dialog changed — check it and answer again.")
  if (hasCode(error, "CONFLICT")) {
    const reason = conflictReasonOf(error)
    return reason
      ? conflictFailure(reason, "answer")
      : new Error("Couldn't answer that here. Answer it in the terminal.")
  }
  if (hasCode(error, "WORDS_NOT_SENT")) return new WordsLost()
  if (hasCode(error, "ANSWER_FAILED"))
    return new Error("That answer didn't take. Answer it in the terminal.")
  if (hasCode(error, "NOT_FOUND")) return new Error("That request is already answered.")
  return new Error("Couldn't answer for the agent.")
}

type Reading = {
  // Ends both streams; the reading is over.
  readonly stop: () => void
}

const read = (
  streams: ConversationStreams,
  terminalId: string,
  store: MutableStore<Conversation>,
): Reading => {
  let alive = true
  // What the transcript now read belongs to, and its stream.
  let following: string | null = null
  let transcript: Stream<TranscriptChange> | undefined
  let detail: Stream<AgentDetail> | undefined
  let slices: Stream<SliceChange> | undefined
  // Settles a read again after a reset once it has been quiet.
  let settling: ReturnType<typeof setTimeout> | undefined
  // Reads that failed in a row without getting further than the one before, when the last
  // began, and the timer of the next, with when it is due.
  let failures = 0
  let lastAttempt = Number.NEGATIVE_INFINITY
  let retrying: ReturnType<typeof setTimeout> | undefined
  let due = Number.POSITIVE_INFINITY

  const markLoaded = (): void => {
    store.update((current) => (current.loaded ? current : { ...current, loaded: true }))
  }

  const stopRetrying = (): void => {
    clearTimeout(retrying)
    retrying = undefined
    due = Number.POSITIVE_INFINITY
  }

  // Asks again at `at` (epoch milliseconds), unless a sooner ask is already due.
  const retryAt = (session: string, root: string, at: number): void => {
    if (retrying !== undefined && due <= at) return
    clearTimeout(retrying)
    due = at
    retrying = setTimeout(
      () => {
        stopRetrying()
        if (alive && transcript === undefined && following === `${session}/${root}`)
          follow(session, root)
      },
      Math.max(0, at - Date.now()),
    )
  }

  // A read that threw or was lost while the snapshot still names its session and root: the
  // runner may not know the transcript yet, so it asks again, a fresh read from the first
  // item replacing what shows, and the chat stays loading until a few reads have failed.
  const failed = (session: string, root: string): void => {
    failures += 1
    if (failures >= failuresToLoaded) markLoaded()
    retryAt(session, root, lastAttempt + Math.min(retryMs * 2 ** (failures - 1), retryMaxMs))
  }

  const follow = (session: string, root: string): void => {
    lastAttempt = Date.now()
    stopRetrying()
    // What shows now, which a read again must reach before it replaces it.
    const shown = store.getSnapshot().items.length
    let stream: Stream<TranscriptChange>
    try {
      stream = streams.transcript(terminalId, root)
    } catch {
      failed(session, root)
      return
    }
    transcript = stream
    // A transcript with nothing in it sends no batch: once it has been quiet a while, what
    // shows is all there is yet.
    const quiet = setTimeout(() => {
      if (!alive || transcript !== stream) return
      failures = 0
      markLoaded()
    }, loadedMs)
    // After a reset, or a read again over items on show, it builds here while they stay.
    let pending: readonly ChatItem[] | null = shown > 0 ? [] : null
    const swap = (): void => {
      clearTimeout(settling)
      settling = undefined
      const items = pending
      pending = null
      if (items !== null) store.update((current) => ({ ...current, items }))
    }
    void (async () => {
      let lost = false
      try {
        for await (const change of stream) {
          if (!alive || transcript !== stream) return
          // Kept through a rewrite: the session is the same, and so is what it holds.
          if (change.type === "unread") {
            store.update((current) => (current.unread ? current : { ...current, unread: true }))
            continue
          }
          if (change.type === "reset") {
            clearTimeout(settling)
            settling = undefined
            pending = []
            continue
          }
          // Further than the read before got: the failures so far were of another kind.
          if (change.items.some((each) => each.index >= shown)) failures = 0
          if (pending === null) {
            store.update((current) => ({
              ...current,
              loaded: true,
              items: withBatch(current.items, session, change.items),
            }))
            continue
          }
          pending = withBatch(pending, session, change.items)
          clearTimeout(settling)
          // Once it is as long as what shows, or quiet for a while, it takes its place.
          if (pending.length >= store.getSnapshot().items.length) swap()
          else settling = setTimeout(swap, settleMs)
        }
      } catch {
        // Not found, or lost: the conversation is what arrived, and it is read again.
        lost = true
      }
      // Ended, as when the agent left the session: the next snapshot says what follows.
      if (!alive || transcript !== stream) return
      clearTimeout(quiet)
      transcript = undefined
      // A read lost before it got as far as what shows leaves that as it is.
      if (lost && pending !== null && pending.length < store.getSnapshot().items.length)
        pending = null
      swap()
      if (lost) failed(session, root)
      else markLoaded()
    })()
  }

  const apply = (snapshot: AgentDetail): void => {
    const session = snapshot.agent === null ? null : snapshot.sessionId
    const root = rootOf(snapshot)
    const key = session !== null && root !== null ? `${session}/${root}` : null
    const changed = key !== following
    if (changed) {
      following = key
      end(transcript)
      transcript = undefined
      clearTimeout(settling)
      settling = undefined
      stopRetrying()
      failures = 0
      lastAttempt = Number.NEGATIVE_INFINITY
    }
    const requests = requestsOf(snapshot, root)
    const prompts = promptsOf(snapshot, changed ? [] : store.getSnapshot().prompts)
    const box = snapshot.box ?? null
    store.update((current) => {
      const same =
        !changed &&
        current.agent === snapshot.agent &&
        current.session === session &&
        sameBox(current.box, box) &&
        sameRequests(current.requests, requests) &&
        samePrompts(current.prompts, prompts)
      if (same) return current
      return {
        agent: snapshot.agent,
        session,
        slice: current.slice,
        box: sameBox(current.box, box) ? current.box : box,
        requests: sameRequests(current.requests, requests) ? current.requests : requests,
        prompts: samePrompts(current.prompts, prompts) ? current.prompts : prompts,
        ...(changed
          ? { loaded: false, items: [], unread: false }
          : { loaded: current.loaded, items: current.items, unread: current.unread }),
      }
    })
    if (session === null || root === null) return
    if (changed) {
      follow(session, root)
      return
    }
    // A read that ended or failed meanwhile is asked again, as the snapshot may be what the
    // runner now knows the transcript by, but no oftener than the wait between reads.
    if (transcript !== undefined) return
    const at = lastAttempt + retryMs
    if (Date.now() >= at) follow(session, root)
    else retryAt(session, root, at)
  }

  try {
    detail = streams.detail(terminalId)
    slices = streams.slice(terminalId)
  } catch {
    end(detail)
    return { stop: () => {} }
  }
  const stream = detail
  const sliceStream = slices
  void (async () => {
    try {
      for await (const { slice } of sliceStream) {
        if (!alive) return
        store.update((current) => ({ ...current, slice }))
      }
    } catch {
      // The terminal is gone, or the runner closed: `detail` tells the same.
    }
    // What its stream last said no longer holds.
    if (alive) store.update((current) => (current.slice ? { ...current, slice: null } : current))
  })()
  void (async () => {
    try {
      for await (const snapshot of stream) {
        if (!alive) return
        apply(snapshot)
      }
    } catch {
      // The terminal is gone, or the runner closed.
    }
    // Its terminal went: so did its conversation, and what waited on it hears so.
    if (!alive) return
    following = null
    end(slices)
    end(transcript)
    transcript = undefined
    clearTimeout(settling)
    stopRetrying()
    store.update(() => noConversation)
  })()

  return {
    stop: () => {
      alive = false
      end(detail)
      end(slices)
      end(transcript)
      transcript = undefined
      clearTimeout(settling)
      stopRetrying()
    },
  }
}

type Entry = {
  readonly store: MutableStore<Conversation>
  readonly conversation: Store<Conversation>
}

export const createRunnerConversations = (
  streams: ConversationStreams,
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerConversations => {
  const entries = new Map<string, Entry>()
  const readings = new Map<string, Reading>()

  const entryOf = (terminalId: string): Entry => {
    const known = entries.get(terminalId)
    if (known) return known
    const store = createStore<Conversation>(noConversation)
    let subscribers = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const halt = (): void => {
      clearTimeout(timer)
      timer = undefined
      const reading = readings.get(terminalId)
      readings.delete(terminalId)
      reading?.stop()
      store.update(() => noConversation)
    }
    const entry: Entry = {
      store,
      conversation: {
        getSnapshot: store.getSnapshot,
        subscribe: (listener) => {
          const unsubscribe = store.subscribe(listener)
          subscribers += 1
          clearTimeout(timer)
          timer = undefined
          if (!readings.has(terminalId)) readings.set(terminalId, read(streams, terminalId, store))
          let subscribed = true
          return () => {
            if (!subscribed) return
            subscribed = false
            unsubscribe()
            subscribers -= 1
            if (subscribers === 0) timer = setTimeout(halt, graceMs)
          }
        },
      },
    }
    entries.set(terminalId, entry)
    stoppers.set(terminalId, halt)
    return entry
  }
  const stoppers = new Map<string, () => void>()
  // The keys on their way to each terminal, and when the last went.
  const passing = new Map<string, { readonly done: Promise<void>; at: number }>()

  return {
    // The runner's terminal ids are unique, so the id alone names the terminal.
    conversation: ({ terminalId }) => entryOf(terminalId).conversation,
    send: ({ terminalId }, text, options) =>
      track(streams.prompt(terminalId, text, options)).then(
        ({ tracked, returned }) => ({ tracked, returned: returned ?? null }),
        (error: unknown) => {
          throw failure(error, "reach", "send")
        },
      ),
    // Nothing here is the person's to act on: words not moved stay where they are.
    keys: ({ terminalId }, keys) => {
      // In order, each after the one before; Enter on its own, a moment behind them.
      const last = passing.get(terminalId) ?? { done: Promise.resolve(), at: 0 }
      const done = last.done
        .catch(() => {})
        .then(async () => {
          const wait = keys === "\r" ? last.at + enterGapMs - Date.now() : 0
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
          await track(streams.keys(terminalId, keys))
          entry.at = Date.now()
        })
      const entry = { done, at: last.at }
      passing.set(terminalId, entry)
      return done.catch((error: unknown) => {
        throw failure(error, "reach", "send")
      })
    },
    takeBox: ({ terminalId }) =>
      track(streams.takeBox(terminalId)).then(
        ({ returned }) => returned,
        () => null,
      ),
    putBox: ({ terminalId }, text) =>
      track(streams.putBox(terminalId, text)).then(
        ({ placed }) => placed,
        () => false,
      ),
    interrupt: ({ terminalId }) =>
      track(streams.interrupt(terminalId)).then(
        ({ returned }) => returned,
        (error: unknown) => {
          throw failure(error, "stop", "stop")
        },
      ),
    answer: ({ terminalId }, request, answer) =>
      track(streams.answer(terminalId, request, requestAnswerOf(answer))).catch(
        (error: unknown) => {
          throw refusal(error)
        },
      ),
    // The protocol's rule, which the runner refuses by; blank text has nothing to warn of yet.
    refused: (text, options) =>
      normalisedText(text).trim() !== "" && protocolRefusal(text, options) !== undefined,
    stop: () => {
      for (const halt of stoppers.values()) halt()
    },
  }
}
