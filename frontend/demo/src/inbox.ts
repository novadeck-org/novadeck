import { followFinishes, type FollowedFinish } from "@novadeck/core/agents/finish"
import type { Conversation, Conversations } from "@novadeck/core/conversation"
import type { AgentName } from "@novadeck/core/harnesses"
import {
  emptyInbox,
  rowKey,
  ordered,
  type Inbox,
  type InboxAnswer,
  type InboxBinding,
  type InboxContent,
  type InboxRow,
  type InboxState,
  type Settled,
  type SettledHow,
  type InboxTurn,
} from "@novadeck/core/inbox"
import { answerLine, createInboxHistory } from "@novadeck/core/inbox/history"
import { dialogMs, inboxRows, type Asked, type WrittenEntry } from "@novadeck/core/inbox/rows"
import { answerRow, createInboxTracker, keepInbox, keyOf } from "@novadeck/core/inbox/tracker"
import { noMessages, type InboxHistory, type Messages } from "@novadeck/core/messages"
import { createStore, type Store } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"
import type { TerminalKey, TerminalMetadata, Workspace } from "@novadeck/core/types"

import { demoInboxRows } from "./inbox/fixtures"
import { deliveryMs } from "./messages"
import { terminalOf, terminalsOf } from "./workspace"

// The demo's Inbox: what its agents wait on, built as the runner's is (`createDemoInbox`),
// and the hardcoded rows below on the sample terminals, which the Inbox demo shows and the
// debug panel adds, answered for a moment and then resolved, kept as history.

// How long an answered row stays, marked answering, before it goes.
export const answerMs = 600

// The Inbox with what only the demo does: a row of its own arriving or leaving, and its
// own rows emptied (`empty` leaves what its agents wait on).
export type DemoInbox = Inbox & {
  readonly add: (row: InboxRow) => void
  readonly empty: () => void
  // The next answer fails instead of taking, so the sheet shows why: not an update's read,
  // which the Inbox makes on its own.
  readonly failNext: (reason?: string) => void
  // An ask leaves: "withdrawn" by its agent leaves the Inbox, as the runner's does; "gone" (its
  // session ended) stays as a resolved row.
  readonly resolve: (id: string, outcome: "withdrawn" | "gone") => void
  // The person wrote to the terminal's agent: its open asks from before are withdrawn, as
  // the runner withdraws them at the person's own prompt: those made before they sent it.
  // They stay as resolved rows, replied.
  readonly withdrawAsks: (key: TerminalKey, before: number) => void
  readonly dropReplyNext: () => void
  // The terminal's agent called `done`: its report becomes an Update once the terminal is
  // there, as the runner's done entry does, a worker's as any other's.
  readonly done: (key: TerminalKey, report: { subject: string; body: string }) => void
}

// Whether a backend's Inbox is the demo's, which the debug panel adds rows to.
export const isDemoInbox = (inbox: Inbox | undefined): inbox is DemoInbox =>
  inbox !== undefined &&
  "add" in inbox &&
  "empty" in inbox &&
  "failNext" in inbox &&
  "done" in inbox

// An answer fits the row it is for, by kind.
const answers = (content: InboxContent, answer: InboxAnswer): boolean =>
  content.kind === answer.kind

const withoutKey = <V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([each]) => each !== key))

// Turning auto-resume on or off: with it off the agent waits for the person.
const resumed = (found: InboxRow, on: boolean): InboxRow =>
  found.kind === "trouble" && found.trouble.type === "limit"
    ? { ...found, stopped: !on, trouble: { ...found.trouble, autoResume: on } }
    : found

// How long an answer to trouble may leave its row standing before it can be answered again.
// Shorter than the runner's: the demo's agents answer at once, and one stopped at rest stays
// as it was, so the buttons should not stay gone for long.
const settleMs = 3000

// A request's id as the Inbox has it, unique across the workspace: the demo's transcripts give
// each sample terminal's requests the same ids in every session.
const scoped = (key: TerminalKey, id: string): string => `${terminalKeyId(key)}/${id}`

// The stored row a finish makes, as the runner's recorder would: the end's own fields from the
// terminal's `lastTurn` (the finish carries only its reply), the row's id its terminal and `at`.
const turnOf = ({ context, terminal, finish, at }: FollowedFinish): InboxTurn | undefined => {
  if (terminal.state !== "running" || !terminal.agent) return undefined
  const end = terminal.agent.lastTurn?.at === at ? terminal.agent.lastTurn : undefined
  // A usage limit is a state, not a row: the runner never records one.
  if (end?.limit || end?.limited) return undefined
  const slash = context.indexOf("/")
  return {
    id: `turn:${context}/${terminal.id}:${at}`,
    projectId: context.slice(0, slash),
    workspaceSessionId: context.slice(slash + 1),
    terminalId: terminal.id,
    handle: terminal.handle ?? "",
    agent: terminal.process as AgentName,
    at,
    outcome: finish.failed ? "failed" : "completed",
    reply: end?.reply ?? finish.reply ?? null,
    error: end?.error ?? null,
    files: end?.files ?? [],
  }
}

// What the demo's Inbox is built from, as the runner's is from the runner: the agents'
// conversations, which hold what each asks and answer it as its screen does; the messages
// held for release, where the demo has messages; and a way to take an agent past what it
// waits on, once the person answered one of the demo's own rows for it.
export type DemoInboxSources = {
  readonly conversations: Conversations
  readonly messages?: Messages | undefined
  readonly resume: (key: TerminalKey, terminal: TerminalMetadata) => void
}

// Every running terminal of the workspace that waits on the person, by its full address.
const waiting = (workspace: Workspace): { key: TerminalKey; terminal: TerminalMetadata }[] =>
  terminalsOf(workspace).filter(
    ({ terminal }) => terminal.state === "running" && terminal.agent?.attention,
  )

// Every row stands on its own, as in core's `inboxRows`, but for one: the demo's own rows
// that wait on the person for their agent (a request, an ask, trouble) stand in for what
// their terminal's agent waits on, so they take the place of a dialog that agent's own
// story shows there, which no real agent shows beside another.
const merged = (own: readonly InboxRow[], derived: readonly InboxRow[]): InboxRow[] => {
  const taken = new Set(
    own
      .filter((each) => each.kind !== "held" && each.kind !== "update")
      .map((each) => each.source.terminalId),
  )
  return ordered([
    ...own,
    ...derived.filter(
      (each) => each.settled || each.kind !== "request" || !taken.has(each.source.terminalId),
    ),
  ])
}

// What the person's answer to one of the demo's own rows made of it: how it ended, and with
// what words.
const resolution = (found: InboxRow, answer: InboxAnswer): Pick<Settled, "how" | "answer"> => {
  if (found.kind === "request" && answer.kind === "request")
    return { how: "answered", answer: answerLine(found.request, answer.answer) }
  if (found.kind === "held" && answer.kind === "held")
    return { how: answer.action === "release" ? "released" : "stopped" }
  if (found.kind === "ask" && answer.kind === "ask") {
    const { shape } = found.ask
    const picked =
      answer.answer.type === "reply" && answer.answer.option !== null && shape.type === "options"
        ? shape.options[answer.answer.option]?.label
        : answer.answer.type === "done" && shape.type === "action"
          ? shape.doneLabel
          : undefined
    const words = answer.answer.type === "reply" ? answer.answer.text.trim() : ""
    return { how: "answered", answer: [picked, words].filter(Boolean).join(": ") }
  }
  if (found.kind === "update") return { how: "read" }
  return { how: "worked" }
}

// The demo's Inbox, built as the runner's is once the app binds it (core's `inboxRows`):
// what its agents wait on, their done reports and the messages held for release, answered
// through their conversations and messages, so an answer here moves the agent on as one on
// its screen does. Over those, the rows the demo shows that its agents don't make: `rows`,
// the Inbox demo's showcase, and what the debug panel adds, answered for a moment and then
// gone, taking the agent past what it waited on where it did.
export const createDemoInbox = (
  now: number,
  rows: readonly InboxRow[] = demoInboxRows(now),
  record: (row: InboxRow, answer?: InboxAnswer, outcome?: InboxHistory) => void = () => {},
  sources?: DemoInboxSources,
): DemoInbox => {
  for (const each of rows) record(each)
  // The demo's own rows.
  const own = createStore<InboxState>({ ...emptyInbox, items: [...rows] })
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
  // The order the person drags the rows into, kept for as long as the page is.
  const order = createStore<readonly string[]>([])
  // The finished turns it stores, as the runner stores them (a completed one only marks its
  // tab): until read, while their terminal is there. Undefined while nothing is bound.
  const turns = createStore<readonly InboxTurn[] | undefined>(undefined)
  const dropTurns = (drop: (row: InboxTurn) => boolean): void => {
    turns.update((current) => {
      const kept = current?.filter((row) => !drop(row))
      return kept && current && kept.length < current.length ? kept : current
    })
  }
  // The done entries its agents wrote, until read, as the runner stores them with the asks.
  let doneCount = 0
  let doneEntries: readonly {
    readonly id: string
    readonly key: TerminalKey
    readonly agent: AgentName
    readonly handle: string
    readonly at: number
    readonly subject: string
    readonly body: string
    // Once read: it stays, as the runner's does.
    readonly settled?: Settled
  }[] = []
  const readTurns = (ids: readonly string[]): void => {
    for (const id of ids) {
      const row = derived.getSnapshot().items.find((each) => each.id === id)
      if (row?.kind === "update") record(row, { kind: "update", action: "read" })
    }
    dropTurns((row) => ids.includes(row.id))
    if (doneEntries.some(({ id, settled }) => !settled && ids.includes(id))) {
      const at = Date.now()
      doneEntries = doneEntries.map((entry) =>
        !entry.settled && ids.includes(entry.id)
          ? { ...entry, settled: { how: "read", at } }
          : entry,
      )
      recompute()
    }
  }
  own.subscribe(() => state.update(combine))
  derived.subscribe(() => state.update(combine))

  let failing: string | null = null
  let dropping = false
  const ownRow = (id: string): InboxRow | undefined =>
    own.getSnapshot().items.find((each) => each.id === id)

  // A row of the demo's own is no longer open: it stays as a resolved row, saying how it ended.
  const resolve = (id: string, how: SettledHow, answer?: string): void => {
    change((current) => ({
      ...current,
      items: current.items.map((each) =>
        each.id === id
          ? {
              ...each,
              stopped: false,
              settled: { how, at: Date.now(), ...(answer ? { answer } : {}) },
            }
          : each,
      ),
      failed: withoutKey(current.failed, id),
    }))
  }

  // An ask of the demo's own is no longer open, kept in the Messages history as `outcome`: its
  // agent's withdrawal takes it out of the Inbox, the rest keep it as a resolved row.
  const settle = (id: string, how: "dismissed" | "withdrawn" | "replied" | "gone"): void => {
    const found = ownRow(id)
    if (found?.kind !== "ask" || found.settled) return
    record(
      found,
      undefined,
      how === "gone" ? "gone" : how === "dismissed" ? "dismissed" : "withdrawn",
    )
    if (how === "withdrawn")
      return change((current) => ({
        ...current,
        items: current.items.filter((each) => each.id !== id),
        failed: withoutKey(current.failed, id),
      }))
    resolve(id, how === "gone" ? "ended" : how)
  }

  let binding: InboxBinding | null = null
  // What ended among the agents' rows, kept for as long as the page is.
  const history = createInboxHistory({ save: () => {} })
  // What was seen, answered or failed among the agents' rows.
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
    const found = inboxRows({
      workspace,
      turns: turns.getSnapshot() ?? [],
      messages: sources.messages?.state.getSnapshot() ?? noMessages,
      entries: doneEntries.map(({ key, ...entry }): WrittenEntry => ({
        id: entry.id,
        terminalId: key.terminalId,
        projectId: key.projectId,
        workspaceSessionId: key.workspaceSessionId,
        agent: entry.agent,
        handle: entry.handle,
        at: entry.at,
        content: { kind: "done", subject: entry.subject, body: entry.body },
        ...(entry.settled ? { settled: entry.settled } : {}),
      })),
      requests,
      now: at,
      // The demo's messages wait for no idle agent long.
      longHoldMs: null,
    })
    const resolved = history.view(found, {
      workspace,
      messages: sources.messages?.state.getSnapshot() ?? noMessages,
    })
    const view = tracker.view(resolved.rows)
    derived.update((current) => keepInbox(current, view))
    if (resolved.read.length > 0) readTurns(resolved.read)
    // A request whose dialog is unread shows anyway once it has waited long enough.
    tracker.wake(
      Object.values(requests)
        .flat()
        .filter(({ request }) => request.dialog === null)
        .map(({ askedAt }) => askedAt + dialogMs - at),
    )
  }
  const answerDerived = (target: InboxRow, given: InboxAnswer): void => {
    if (!sources || !binding || target.settled || derived.getSnapshot().answering[target.id]) return
    if (target.kind !== given.kind)
      return tracker.fail(target.id, "That answer isn't for this item.")
    // An update's read, which the Inbox makes on its own, isn't the answer that fails.
    if (failing && given.kind !== "update") {
      const why = failing
      failing = null
      return tracker.fail(target.id, why)
    }
    const { conversations, messages } = sources
    const { workspace } = binding
    answerRow(tracker, target, given, {
      request: (key, { request }, answer) => {
        history.note(target.id, "answered", answerLine(request, answer))
        return conversations.answer(key, request.id.slice(scoped(key, "").length), answer)
      },
      release: (thread) => {
        history.note(target.id, "released")
        messages?.release(thread)
      },
      stop: (thread) => {
        history.note(target.id, "stopped")
        messages?.stop(thread)
      },
      read: readTurns,
      forget: readTurns,
      send: (key, text, options) => conversations.send(key, text, options),
      interrupt: (key) => conversations.interrupt(key),
      terminal: (key) => terminalOf(workspace.getSnapshot(), key),
    })
  }
  // An answered row of the demo's own for an agent that waits takes it past what it waits on.
  const release = (answered: InboxRow): void => {
    if (answered.kind !== "request" || !sources || !binding) return
    const key = keyOf(answered)
    const terminal = terminalOf(binding.workspace.getSnapshot(), key)
    if (terminal?.state === "running" && terminal.agent?.attention) sources.resume(key, terminal)
  }

  return {
    state,
    turns,
    readFinishes: (finishes) => {
      const read = new Set(finishes.map(({ context, terminalId }) => `${context}/${terminalId}`))
      dropTurns((row) => read.has(`${row.projectId}/${row.workspaceSessionId}/${row.terminalId}`))
    },
    bind: (next) => {
      binding = next
      turns.update(() => [])
      // A row is kept while its terminal is there, and only the first of an end.
      const stopFinishes = followFinishes(next.workspace, (found) => {
        const row = turnOf(found)
        if (row)
          turns.update((current) =>
            current?.some((each) => each.id === row.id) ? current : [...(current ?? []), row],
          )
      })
      const present = (): void => {
        const workspace = next.workspace.getSnapshot()
        dropTurns((row) => !terminalOf(workspace, row))
      }
      const stops = [
        ...[next.workspace, turns, ...(sources?.messages ? [sources.messages.state] : [])].map(
          (store) => store.subscribe(recompute),
        ),
        next.workspace.subscribe(present),
        stopFinishes,
      ]
      recompute()
      return () => {
        stops.forEach((stop) => stop())
        turns.update(() => undefined)
        for (const each of followed.values()) each.stop()
        followed.clear()
        tracker.reset()
        doneEntries = []
        asked.clear()
        if (binding === next) binding = null
        derived.update(() => emptyInbox)
      }
    },
    answer: (id, answer) => {
      const found = ownRow(id)
      if (!found) {
        const theirs = derived.getSnapshot().items.find((each) => each.id === id)
        if (theirs) answerDerived(theirs, answer)
        return
      }
      if (own.getSnapshot().answering[id] || found.settled) return
      if (!answers(found, answer))
        return change((current) => ({
          ...current,
          failed: { ...current.failed, [id]: "That answer isn't for this item." },
        }))
      // An update's read, which the Inbox makes on its own, isn't the answer that fails.
      if (failing && answer.kind !== "update") {
        const why = failing
        failing = null
        return change((current) => ({
          ...current,
          failed: { ...current.failed, [id]: why },
        }))
      }
      // Auto-resume only changes how the agent goes on; the row stays.
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
        const { how, answer: words } = resolution(found, answer)
        change((current) => ({
          items: current.items.map((each) =>
            each.id === id
              ? {
                  ...each,
                  stopped: false,
                  settled: { how, at: Date.now(), ...(words ? { answer: words } : {}) },
                }
              : each,
          ),
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
      if (!ownRow(id)) {
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
    add: (added) => {
      if (!added.settled) record(added)
      change((current) => ({
        ...current,
        items: [...current.items.filter((each) => each.id !== added.id), added],
      }))
    },
    resolve: (id, outcome) => settle(id, outcome),
    dismiss: (id) => {
      const found = ownRow(id)
      if (found?.kind !== "ask" || found.settled || own.getSnapshot().answering[id]) return
      // A dismissal that fails leaves the ask as it was, with no error shown.
      if (failing) {
        failing = null
        return
      }
      settle(id, "dismissed")
    },
    order,
    // Only the rows still listed: the order forgets the gone.
    arrange: (keys) => {
      const listed = new Set(state.getSnapshot().items.map(rowKey))
      order.update(() => keys.filter((key) => listed.has(key)))
    },
    withdrawAsks: (key, before) => {
      for (const each of own.getSnapshot().items)
        if (
          each.kind === "ask" &&
          !each.settled &&
          each.at < before &&
          each.source.projectId === key.projectId &&
          each.source.workspaceSessionId === key.workspaceSessionId &&
          each.source.terminalId === key.terminalId
        )
          settle(each.id, "replied")
    },
    dropReplyNext: () => {
      dropping = true
    },
    done: (key, report) => {
      const workspace = binding?.workspace.getSnapshot()
      const project = workspace?.projects.find((each) => each.id === key.projectId)
      const terminal = workspace && terminalOf(workspace, key)
      if (!project || terminal?.state !== "running") return
      const at = Date.now()
      doneCount += 1
      const id = `entry:demo-done-${doneCount}`
      const agent = terminal.process as AgentName
      const handle = terminal.handle ?? ""
      doneEntries = [...doneEntries, { id, key, agent, handle, at, ...report }]
      recompute()
      // The Messages trace keeps it whether or not the Inbox shows it, as the runner's does.
      record({
        id,
        source: {
          ...key,
          handle,
          agent,
          title: terminal.name,
          projectName: project.name,
        },
        at,
        stopped: false,
        seen: false,
        kind: "update",
        update: { type: "done", ...report },
      })
    },
    empty: () => change(() => emptyInbox),
    failNext: (reason = "The agent didn't take that answer. Try again.") => {
      failing = reason
    },
  }
}
