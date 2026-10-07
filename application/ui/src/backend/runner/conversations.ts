import {
  normalisedText,
  promptRefusal as protocolRefusal,
  type AgentDetail,
  type RequestAnswer,
  type TranscriptChange,
  type TranscriptItem,
} from "@novadeck/protocol"
import { hasCode } from "@novadeck/protocol/client"

import {
  noConversation,
  type ChatAnswer,
  type ChatDialog,
  type ChatItem,
  type ChatRequest,
  WordsLost,
  type Conversation,
  type Conversations,
} from "../../model/conversation"
import { promptRefusal } from "../../model/prompt-refusal"
import { createStore, type MutableStore, type Store } from "../../model/store"

// The runner's conversations: each terminal's agent as `agents.detail` follows it, and
// the root agent's transcript as `agents.transcript` streams it. Reading a terminal
// starts with its first subscriber and stops a while after its last leaves, so
// switching views or sessions doesn't start it over; stopping always ends both streams.

export type ConversationStreams = {
  readonly detail: (terminalId: string) => AsyncIterableIterator<AgentDetail, undefined>
  readonly transcript: (
    terminalId: string,
    actor: string,
  ) => AsyncIterableIterator<TranscriptChange, undefined>
  readonly prompt: (terminalId: string, text: string) => Promise<void>
  readonly interrupt: (terminalId: string) => Promise<{ readonly returned: string | null }>
  readonly answer: (terminalId: string, request: string, answer: RequestAnswer) => Promise<void>
}

export type RunnerConversations = Conversations & {
  // Stops reading every terminal at once.
  readonly stop: () => void
}

// How long a terminal keeps being read after its last subscriber left, in milliseconds.
export const graceMs = 30_000

// How long a read again after a reset may be quiet before it replaces what shows, in
// milliseconds.
export const settleMs = 500

// How long a transcript may be open without a batch before it counts as read: the runner
// sends none for a session whose file is empty, and goes on following it, in milliseconds.
export const loadedMs = 1000

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

const requestsOf = (detail: AgentDetail, root: string | null): readonly ChatRequest[] =>
  detail.requests.map((request) => ({
    id: request.ref,
    kind: request.kind,
    tool: request.tool,
    subject: request.subject,
    choices: request.choices,
    subagent: request.actor !== root,
    dialog: request.dialog,
    answered: request.answered,
  }))

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

// What the person is told when the agent can't take what they sent.
const failure = (error: unknown, what: string): Error => {
  if (hasCode(error, "DISCONNECTED", "CLOSED")) return new Error("The runner is offline.")
  // Refused before anything was written: the text has a shape the agent reads as more than
  // a message, or the agent can't take one now (its box holds a draft, or it waits on the
  // person's answer). The runner says which.
  if (hasCode(error, "PROMPT_REFUSED")) return new Error(said(error) ?? promptRefusal)
  if (hasCode(error, "CONFLICT"))
    return new Error(
      said(error) ??
        "The agent can't take a prompt right now. It may be waiting for your answer in the terminal.",
    )
  // Stopped, but the words queued behind the turn stay in the agent's own box.
  if (hasCode(error, "BOX_NOT_CLEARED"))
    return new Error(
      "Stopped. Your queued message is still in the agent's box: clear it in the terminal.",
    )
  if (hasCode(error, "PROMPT_FAILED"))
    return new Error("The prompt didn't land in the agent's box. It may be there as a draft.")
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
  if (hasCode(error, "CONFLICT"))
    return new Error(said(error) ?? "Couldn't answer that here. Answer it in the terminal.")
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
  // Settles a read again after a reset once it has been quiet.
  let settling: ReturnType<typeof setTimeout> | undefined

  const follow = (session: string, root: string): void => {
    let stream: Stream<TranscriptChange>
    try {
      stream = streams.transcript(terminalId, root)
    } catch {
      store.update((current) => (current.loaded ? current : { ...current, loaded: true }))
      return
    }
    transcript = stream
    // A transcript with nothing in it sends no batch: once it has been quiet a while, what
    // shows is all there is yet.
    const quiet = setTimeout(() => {
      if (alive && transcript === stream)
        store.update((current) => (current.loaded ? current : { ...current, loaded: true }))
    }, loadedMs)
    // After a reset the read again builds here while the old items stay on show.
    let pending: readonly ChatItem[] | null = null
    const swap = (): void => {
      clearTimeout(settling)
      settling = undefined
      const items = pending
      pending = null
      if (items !== null) store.update((current) => ({ ...current, items }))
    }
    void (async () => {
      try {
        for await (const change of stream) {
          if (!alive || transcript !== stream) return
          if (change.type === "reset") {
            clearTimeout(settling)
            settling = undefined
            pending = []
            continue
          }
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
        // Not found, or lost: the conversation is what arrived.
      }
      // Ended, as when the agent left the session: the next snapshot says what follows.
      if (!alive || transcript !== stream) return
      clearTimeout(quiet)
      transcript = undefined
      swap()
      store.update((current) => (current.loaded ? current : { ...current, loaded: true }))
    })()
  }

  const apply = (snapshot: AgentDetail): void => {
    const session = snapshot.agent === null ? null : snapshot.sessionId
    const root = snapshot.actors.find((actor) => actor.role === "root")?.ref ?? null
    const key = session !== null && root !== null ? `${session}/${root}` : null
    const changed = key !== following
    if (changed) {
      following = key
      end(transcript)
      transcript = undefined
      clearTimeout(settling)
      settling = undefined
    }
    const requests = requestsOf(snapshot, root)
    store.update((current) => {
      const same =
        !changed &&
        current.agent === snapshot.agent &&
        current.session === session &&
        sameRequests(current.requests, requests)
      if (same) return current
      return {
        agent: snapshot.agent,
        session,
        requests: sameRequests(current.requests, requests) ? current.requests : requests,
        ...(changed
          ? { loaded: false, items: [] }
          : { loaded: current.loaded, items: current.items }),
      }
    })
    if (changed && session !== null && root !== null) follow(session, root)
  }

  try {
    detail = streams.detail(terminalId)
  } catch {
    return { stop: () => {} }
  }
  const stream = detail
  void (async () => {
    try {
      for await (const snapshot of stream) {
        if (!alive) return
        apply(snapshot)
      }
    } catch {
      // The terminal is gone, or the runner closed.
    }
  })()

  return {
    stop: () => {
      alive = false
      end(detail)
      end(transcript)
      transcript = undefined
      clearTimeout(settling)
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

  return {
    // The runner's terminal ids are unique, so the id alone names the terminal.
    conversation: ({ terminalId }) => entryOf(terminalId).conversation,
    send: ({ terminalId }, text) =>
      track(streams.prompt(terminalId, text)).catch((error: unknown) => {
        throw failure(error, "reach")
      }),
    interrupt: ({ terminalId }) =>
      track(streams.interrupt(terminalId)).then(
        ({ returned }) => returned,
        (error: unknown) => {
          throw failure(error, "stop")
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
