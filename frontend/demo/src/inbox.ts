import type { Conversation, Conversations } from "@novadeck/core/conversation"
import {
  emptyInbox,
  ordered,
  type Inbox,
  type InboxAnswer,
  type InboxBinding,
  type InboxContent,
  type InboxItem,
  type InboxState,
} from "@novadeck/core/inbox"
import {
  answerItem,
  createInboxTracker,
  finishOf,
  keepInbox,
  keyOf,
} from "@novadeck/core/inbox-answers"
import { dialogMs, inboxItems, type Asked } from "@novadeck/core/inbox-items"
import { noMail, type InboxHistory, type Messages } from "@novadeck/core/messages"
import { terminalKeyId } from "@novadeck/core/registry"
import { createStore, type Store } from "@novadeck/core/store"
import type { TerminalKey, TerminalMetadata, Workspace } from "@novadeck/core/types"

import { demoInboxItems } from "./inbox-fixtures"
import { deliveryMs } from "./messages"

// The demo's Inbox: what its agents wait on, built as the runner's is (`createDemoInbox`),
// and the hardcoded items below on the sample terminals, which the Inbox demo shows and the
// debug panel adds, answered for a moment and then gone.

// How long an answered item stays, marked answering, before it goes.
export const answerMs = 600

// The Inbox with what only the demo does: an item of its own arriving or leaving, and its
// own items emptied (`clear` leaves what its agents wait on).
export type DemoInbox = Inbox & {
  readonly add: (item: InboxItem) => void
  readonly clear: () => void
  // The next answer fails instead of taking, so the sheet shows why.
  readonly failNext: (reason?: string) => void
  readonly resolve: (id: string, outcome: "withdrawn" | "gone") => void
  readonly dropReplyNext: () => void
}

// Whether a backend's Inbox is the demo's, which the debug panel adds items to.
export const isDemoInbox = (inbox: Inbox | undefined): inbox is DemoInbox =>
  inbox !== undefined && "add" in inbox && "clear" in inbox && "failNext" in inbox

// An answer fits the item it is for, by source.
const answers = (content: InboxContent, answer: InboxAnswer): boolean =>
  content.kind === answer.kind

const withoutKey = <V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([each]) => each !== key))

// Turning auto-resume on or off: with it off the agent waits for the person.
const resumed = (found: InboxItem, on: boolean): InboxItem =>
  found.kind === "trouble" && found.trouble.type === "limit"
    ? { ...found, stopped: !on, trouble: { ...found.trouble, autoResume: on } }
    : found

// How long an answer to trouble may leave its item standing before it can be answered again.
// Shorter than the runner's: the demo's agents answer at once, and one stopped at rest stays
// as it was, so the buttons should not stay gone for long.
const settleMs = 3000

// A request's id as the Inbox has it, unique across the workspace: the demo's transcripts give
// each sample terminal's requests the same ids in every session.
const scoped = (key: TerminalKey, id: string): string => `${terminalKeyId(key)}/${id}`

// What the demo's Inbox is built from, as the runner's is from the runner: the agents'
// conversations, which hold what each asks and answer it as its screen does; the messages
// held for release, where the demo has messages; and a way to take an agent past what it
// waits on, once the person answered one of the demo's own items for it.
export type DemoInboxSources = {
  readonly conversations: Conversations
  readonly messages?: Messages | undefined
  readonly resume: (key: TerminalKey, terminal: TerminalMetadata) => void
}

// Every running terminal of the workspace that waits on the person, by its full address.
const waiting = (workspace: Workspace): { key: TerminalKey; terminal: TerminalMetadata }[] =>
  workspace.projects.flatMap((project) =>
    project.history.flatMap((session) =>
      session.state.roster.terminals
        .filter((terminal) => terminal.state === "running" && terminal.agent?.attention)
        .map((terminal) => ({
          key: { projectId: project.id, workspaceSessionId: session.id, terminalId: terminal.id },
          terminal,
        })),
    ),
  )

const terminalAt = (workspace: Workspace, key: TerminalKey): TerminalMetadata | undefined =>
  workspace.projects
    .find((project) => project.id === key.projectId)
    ?.history.find((session) => session.id === key.workspaceSessionId)
    ?.state.roster.terminals.find((terminal) => terminal.id === key.terminalId)

// The demo's own items and the derived ones all show, each its own row.
const merged = (own: readonly InboxItem[], derived: readonly InboxItem[]): InboxItem[] =>
  ordered([...own, ...derived])

// The demo's Inbox, built as the runner's is once the app binds it (core's `inboxItems`):
// what its agents wait on, their finishes and the messages held for release, answered
// through their conversations and messages, so an answer here moves the agent on as one on
// its screen does. Over those, the items the demo shows that its agents don't make: `items`,
// the Inbox demo's showcase, and what the debug panel adds, answered for a moment and then
// gone, taking the agent past what it waited on where it did.
export const createDemoInbox = (
  now: number,
  items: readonly InboxItem[] = demoInboxItems(now),
  record: (item: InboxItem, answer?: InboxAnswer, outcome?: InboxHistory) => void = () => {},
  sources?: DemoInboxSources,
): DemoInbox => {
  for (const each of items) record(each)
  // The demo's own items.
  const own = createStore<InboxState>({ ...emptyInbox, items: [...items] })
  const change = (next: (current: InboxState) => InboxState): void => {
    own.update(next)
  }
  // What the demo's agents would show, while the app binds it.
  const derived = createStore<InboxState>(emptyInbox)
  const combine = (current: InboxState): InboxState => {
    const mine = own.getSnapshot()
    const theirs = derived.getSnapshot()
    return keepInbox(current, {
      items: merged(mine.items, theirs.items),
      answering: { ...theirs.answering, ...mine.answering },
      failed: { ...theirs.failed, ...mine.failed },
    })
  }
  const state = createStore<InboxState>(combine(emptyInbox))
  own.subscribe(() => state.update(combine))
  derived.subscribe(() => state.update(combine))

  let failing: string | null = null
  let dropping = false
  const ownItem = (id: string): InboxItem | undefined =>
    own.getSnapshot().items.find((each) => each.id === id)

  let binding: InboxBinding | null = null
  // What was seen, answered or failed among the agents' items.
  const tracker = createInboxTracker({ settleMs, changed: () => recompute() })
  // When the demo first saw each request, which is when it started waiting.
  const asked = new Map<string, number>()
  // The conversations followed, of the terminals that wait, by terminal.
  const followed = new Map<
    string,
    {
      readonly key: TerminalKey
      readonly store: Store<Conversation>
      readonly stop: () => void
    }
  >()
  const follow = (workspace: Workspace): void => {
    if (!sources) return
    const asking = waiting(workspace)
    const ids = new Set(asking.map(({ key }) => terminalKeyId(key)))
    for (const [id, each] of followed)
      if (!ids.has(id)) {
        each.stop()
        followed.delete(id)
      }
    for (const { key } of asking) {
      const id = terminalKeyId(key)
      if (followed.has(id)) continue
      const store = sources.conversations.conversation(key)
      followed.set(id, { key, store, stop: store.subscribe(() => recompute()) })
    }
  }
  const recompute = (): void => {
    if (!binding || !sources) return
    const workspace = binding.workspace.getSnapshot()
    follow(workspace)
    const at = Date.now()
    const requests: Record<string, Asked[]> = {}
    const present = new Set<string>()
    for (const { key, store } of followed.values()) {
      requests[key.terminalId] = store.getSnapshot().requests.map((each) => {
        const request = { ...each, id: scoped(key, each.id) }
        present.add(request.id)
        if (!asked.has(request.id)) asked.set(request.id, at)
        return { request, askedAt: asked.get(request.id)! }
      })
    }
    // A request asked again later waits from then.
    for (const id of asked.keys()) if (!present.has(id)) asked.delete(id)
    const found = inboxItems({
      workspace,
      unread: binding.unread.getSnapshot(),
      mail: sources.messages?.state.getSnapshot() ?? noMail,
      letters: [],
      requests,
      now: at,
      caseless: false,
      // The demo's messages wait for no idle agent long.
      longHoldMs: null,
    })
    const view = tracker.view(found)
    derived.update((current) => keepInbox(current, view))
    // A request whose dialog is unread shows anyway once it has waited long enough.
    tracker.wake(
      Object.values(requests)
        .flat()
        .filter(({ request }) => request.dialog === null)
        .map(({ askedAt }) => askedAt + dialogMs - at),
    )
  }
  const answerDerived = (target: InboxItem, given: InboxAnswer): void => {
    if (!sources || !binding || derived.getSnapshot().answering[target.id]) return
    if (target.kind !== given.kind)
      return tracker.fail(target.id, "That answer isn't for this item.")
    if (failing) {
      const why = failing
      failing = null
      return tracker.fail(target.id, why)
    }
    const { conversations, messages } = sources
    const { workspace, read } = binding
    answerItem(tracker, target, given, {
      request: (key, { request }, answer) =>
        conversations.answer(key, request.id.slice(scoped(key, "").length), answer),
      release: (thread) => messages?.release(thread),
      stop: (thread) => messages?.stop(thread),
      read,
      send: (key, text) => conversations.send(key, text),
      interrupt: (key) => conversations.interrupt(key),
      terminal: (key) => terminalAt(workspace.getSnapshot(), key),
    })
  }
  // An answered item of the demo's own for an agent that waits takes it past what it waits on.
  const release = (answered: InboxItem): void => {
    if (answered.kind !== "request" || !sources || !binding) return
    const key = keyOf(answered)
    const terminal = terminalAt(binding.workspace.getSnapshot(), key)
    if (terminal?.state === "running" && terminal.agent?.attention) sources.resume(key, terminal)
  }

  return {
    state,
    bind: (next) => {
      binding = next
      const stops = [
        next.workspace,
        next.unread,
        ...(sources?.messages ? [sources.messages.state] : []),
      ].map((store) => store.subscribe(recompute))
      recompute()
      return () => {
        stops.forEach((stop) => stop())
        for (const each of followed.values()) each.stop()
        followed.clear()
        tracker.reset()
        asked.clear()
        if (binding === next) binding = null
        derived.update(() => emptyInbox)
      }
    },
    answer: (id, answer) => {
      const found = ownItem(id)
      if (!found) {
        const theirs = derived.getSnapshot().items.find((each) => each.id === id)
        if (theirs) answerDerived(theirs, answer)
        return
      }
      if (own.getSnapshot().answering[id]) return
      if (!answers(found, answer))
        return change((current) => ({
          ...current,
          failed: { ...current.failed, [id]: "That answer isn't for this item." },
        }))
      if (failing) {
        const why = failing
        failing = null
        return change((current) => ({
          ...current,
          failed: { ...current.failed, [id]: why },
        }))
      }
      // Auto-resume only changes how the agent goes on; the item stays.
      if (answer.kind === "trouble" && answer.action.type === "auto-resume") {
        const { on } = answer.action
        return change((current) => ({
          ...current,
          items: current.items.map((each) => (each.id === id ? resumed(each, on) : each)),
          failed: withoutKey(current.failed, id),
        }))
      }
      change((current) => ({
        ...current,
        answering: { ...current.answering, [id]: true },
        failed: withoutKey(current.failed, id),
      }))
      const undelivered = dropping && answer.kind === "ask"
      if (undelivered) dropping = false
      setTimeout(() => {
        record(found, answer, undelivered ? "undelivered" : undefined)
        change((current) => ({
          items: current.items.filter((each) => each.id !== id),
          answering: withoutKey(current.answering, id) as Record<string, true>,
          failed: current.failed,
        }))
        release(found)
        if (undelivered)
          setTimeout(
            () =>
              change((current) => ({
                ...current,
                failed: {
                  ...current.failed,
                  [id]: "Your reply was not delivered because the agent's session ended.",
                },
              })),
            deliveryMs,
          )
      }, answerMs)
    },
    see: (id) => {
      if (!ownItem(id)) {
        if (derived.getSnapshot().items.some((each) => each.id === id)) tracker.see(id)
        return
      }
      change((current) =>
        current.items.some((each) => each.id === id && !each.seen)
          ? {
              ...current,
              items: current.items.map((each) => (each.id === id ? { ...each, seen: true } : each)),
            }
          : current,
      )
    },
    readAll: () => {
      for (const each of own.getSnapshot().items)
        if (each.kind === "update") record(each, { kind: "update", action: "read" })
      change((current) => ({
        ...current,
        items: current.items.filter((each) => each.kind !== "update"),
      }))
      const finishes = derived
        .getSnapshot()
        .items.filter((each) => each.kind === "update")
        .map(finishOf)
      if (finishes.length > 0) binding?.read(finishes)
    },
    add: (added) => {
      record(added)
      change((current) => ({
        ...current,
        items: [...current.items.filter((each) => each.id !== added.id), added],
      }))
    },
    resolve: (id, outcome) => {
      const found = ownItem(id)
      if (found?.kind !== "ask") return
      record(found, undefined, outcome)
      change((current) => ({ ...current, items: current.items.filter((each) => each.id !== id) }))
    },
    dropReplyNext: () => {
      dropping = true
    },
    clear: () => change(() => emptyInbox),
    failNext: (reason = "The agent didn't take that answer. Try again.") => {
      failing = reason
    },
  }
}
