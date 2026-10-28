import type { AgentAsk, InboxAnswer, InboxRow } from "@novadeck/core/inbox"
import { companionKeyId } from "@novadeck/core/items"
import {
  noMessages,
  type AgentMessage,
  type InboxHistory,
  type MessageParty,
  type MessageWaits,
  type MessagesState,
  type MessageThread,
  type Messages,
  type TerminalThreads,
} from "@novadeck/core/messages"
import { createStore } from "@novadeck/core/store"
import type { WorkspaceTarget } from "@novadeck/core/types"

import { demoTerminalId } from "./samples"

// A demo set of messages: threads between the sample terminals, kept the way the runner keeps
// them, so pausing holds what waits and releasing a thread lets it go on, as there.

// The demo keeps who a thread is between by handle, and the person as `you`; its messages
// name them as the runner's do.
const person = "you"

export const partyOf = (handle: string): MessageParty =>
  handle === person ? { kind: "person" } : { kind: "agent", handle, agent: null }

// The runner's loop hold: a thread is held at its sixth idle message in a row, and a pair
// keeps at most ten messages waiting held for release.
const idleToHold = 6
const heldPerPair = 10

// A message as the demo keeps it: where it was before any hold.
export type DemoMessage = Omit<AgentMessage, "state" | "held"> & {
  readonly state: "queued" | "leased" | "delivered" | "gone"
  // Sent while neither end worked. The demo has no tool reports, so the script says which
  // are; a message not marked resets the thread's count.
  readonly idle?: true
}

export type DemoThread = {
  readonly id: string
  // The two terminals, by handle.
  readonly between: readonly [string, string]
  readonly hops: number
  readonly messages: readonly DemoMessage[]
  // The last hop at the person's release: the count of idle messages starts afresh after it.
  readonly releasedAt?: number | undefined
  // Where a send the cap refused would have started the hold: that hop and after are held.
  readonly holdFrom?: number | undefined
  // When the person stopped it: what waited is gone, and a send on it is refused for as long
  // as a thread lasts (`threadMs`) from its latest message or the stop, or until a release.
  readonly stoppedAt?: number | undefined
}

// How long after its latest message a thread is continued, as the runner has it.
const threadMs = 10 * 60_000

const stopBlocks = (thread: DemoThread): boolean =>
  thread.stoppedAt !== undefined &&
  Date.now() - Math.max(thread.messages.at(-1)?.sentAt ?? 0, thread.stoppedAt) <= threadMs

// A session's terminals that take part: each by id, with its handle and whether an agent
// is there to take messages.
export type DemoSessionMessages = {
  readonly target: WorkspaceTarget
  readonly terminals: readonly {
    readonly terminalId: string
    readonly handle: string
    readonly agent: boolean
    // Why the doorbell can't ring it, where the debug panel put it so.
    readonly waits?: MessageWaits | null
  }[]
  readonly threads: readonly DemoThread[]
}

// Where a thread's hold starts, as the runner has it: the hop of the sixth idle message in a
// row since the last release, and every message after it is held too; undefined for none.
const holdHop = (thread: DemoThread): number | undefined => {
  const refused = thread.holdFrom
  let run = 0
  for (const message of thread.messages) {
    if (message.inbox || message.hop <= (thread.releasedAt ?? 0)) continue
    run = message.idle ? run + 1 : 0
    if (run >= idleToHold) return Math.min(message.hop, refused ?? message.hop)
  }
  return refused
}

// The idle messages in a row the thread counts, which stays where it was while held.
const idleRun = (thread: DemoThread): number => {
  if (thread.holdFrom !== undefined) return idleToHold
  let run = 0
  for (const message of thread.messages) {
    if (message.inbox || message.hop <= (thread.releasedAt ?? 0)) continue
    run = message.idle ? run + 1 : 0
    if (run >= idleToHold) return idleToHold
  }
  return run
}

// As the runner says it: a message still waiting is held while paused, or at or past its
// thread's hold.
const shown = (message: DemoMessage, thread: DemoThread, paused: boolean): AgentMessage => {
  const at = holdHop(thread)
  const hold = message.inbox
    ? null
    : at !== undefined && message.hop >= at
      ? "release"
      : paused
        ? "paused"
        : null
  // Whether it was idle is the demo's own: the runner's listing doesn't say.
  const { idle: _idle, ...listed } = message
  return message.state === "queued" && hold
    ? { ...listed, state: "held", held: hold }
    : { ...listed, held: null }
}

const messagesOf = (
  box: DemoSessionMessages,
  handle: string,
  agent: boolean,
  paused: boolean,
  waits: MessageWaits | null,
): TerminalThreads => ({
  handle,
  agent,
  waits,
  threads: box.threads
    .filter((thread) => thread.between.includes(handle))
    .map((thread): MessageThread => {
      const messages = thread.messages.map((message) => shown(message, thread, paused))
      return {
        id: thread.id,
        peer: partyOf(thread.between[0] === handle ? thread.between[1] : thread.between[0]),
        hops: thread.hops,
        idle: idleRun(thread),
        held: holdHop(thread) !== undefined,
        heldFor: holdHop(thread) !== undefined ? "loop" : null,
        messages,
      }
    })
    .toSorted((a, b) => (b.messages.at(-1)?.sentAt ?? 0) - (a.messages.at(-1)?.sentAt ?? 0)),
})

const stateOf = (boxes: readonly DemoSessionMessages[], paused: boolean): MessagesState => ({
  ...noMessages,
  paused,
  terminals: Object.fromEntries(
    boxes.flatMap((box) =>
      box.terminals.map(({ terminalId, handle, agent, waits }) => [
        companionKeyId({ ...box.target, terminalId }),
        messagesOf(box, handle, agent, paused, waits ?? null),
      ]),
    ),
  ),
})

// How long a pause takes to reach the demo's stand-in runner, so its view shows one on
// its way.
const pauseMs = 150
export const deliveryMs = 2000

// How long the doorbell takes to land a message `send` queued.
export const rungMs = 800

// The plain-text record retains the choices and details after the Inbox sheet clears.
const askText = (ask: AgentAsk): string => {
  const { shape } = ask
  const choices =
    shape.type === "options"
      ? shape.options
          .map((option, index) =>
            [
              `${index + 1}. ${option.label}${shape.recommend === index ? " (recommended)" : ""}`,
              option.summary,
              option.details,
              option.code && `${option.code.path}\n${option.code.text}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          )
          .join("\n\n")
      : shape.type === "action"
        ? [shape.command, shape.directory, shape.doneLabel].filter(Boolean).join("\n")
        : null
  return [
    ask.subject,
    ask.body,
    ask.details,
    ask.hardToUndo && `Hard to undo: ${ask.hardToUndo}`,
    choices,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export type DemoMessages = Messages & {
  readonly record: (item: InboxRow, answer?: InboxAnswer, outcome?: InboxHistory) => void
  // An agent's message to another of a session, by handle: queued at first, and delivered once
  // the doorbell has rung (`rungMs` later), nothing holds it (a pause, a loop hold on its
  // thread, a recipient the doorbell can't ring) and its thread wasn't stopped; `delivered`
  // is called then.
  readonly send: (
    target: WorkspaceTarget,
    from: string,
    to: string,
    text: string,
    delivered?: () => void,
    // Called instead if the message is dropped before it lands: the person stops the thread,
    // or its recipient closed. The runner tells a sender so with its next tool answer, and
    // adds nothing to the thread.
    stopped?: () => void,
    // Whether the message is idle: sent while neither end worked, which the demo's script says.
    idle?: boolean,
    // False where the thread was stopped, the recipient closed, or the pair already has ten
    // messages waiting held for release: the runner refuses the send.
  ) => boolean
  // Looks again at what waits, as a terminal may have closed since: a message for one is gone.
  readonly refresh: () => void
}

// Whether a backend's messages are the demo's, which keep a record of what the person answered.
export const isDemoMessages = (messages: Messages | undefined): messages is DemoMessages =>
  messages !== undefined && "record" in messages

type Ring = {
  readonly target: WorkspaceTarget
  readonly thread: string
  readonly message: string
  // The recipient's handle.
  readonly to: string
  rung: boolean
  readonly delivered: (() => void) | undefined
  readonly stopped: (() => void) | undefined
}

// What of the workspace the demo's messages can't know: whether a terminal still exists. A send
// to one closed is refused, and a message queued for one that closes is gone, as in the runner;
// what a closed terminal sent still lands.
export type TerminalExists = (target: WorkspaceTarget, terminalId: string) => boolean

export const createDemoMessages = (
  initial: readonly DemoSessionMessages[],
  paused = false,
  exists: TerminalExists = () => true,
): DemoMessages => {
  let boxes = initial
  let isPaused = paused
  const state = createStore(stateOf(boxes, isPaused))
  const publish = (): void => void state.update(() => stateOf(boxes, isPaused))
  // The messages `send` queued: see `DemoMessages.send`. A held one lands when what held it is
  // lifted; a stopped one never does.
  const rings: Ring[] = []
  const land = (): void => {
    const landed: Ring[] = []
    const lost: Ring[] = []
    for (const ring of rings.toReversed()) {
      const box = boxes.find(
        (each) =>
          each.target.projectId === ring.target.projectId &&
          each.target.workspaceSessionId === ring.target.workspaceSessionId,
      )
      const thread = box?.threads.find((each) => each.id === ring.thread)
      const message = thread?.messages.find((each) => each.id === ring.message)
      if (!box || !thread || message?.state !== "queued") {
        rings.splice(rings.indexOf(ring), 1)
        continue
      }
      const recipient = box.terminals.find((each) => each.handle === ring.to)
      // The recipient closed since: the message is gone, as the runner marks it. A closed
      // sender's message still lands.
      if (recipient && !exists(ring.target, recipient.terminalId)) {
        rings.splice(rings.indexOf(ring), 1)
        lost.push(ring)
        continue
      }
      if (
        !ring.rung ||
        shown(message, thread, isPaused).held ||
        !recipient?.agent ||
        recipient.waits
      )
        continue
      rings.splice(rings.indexOf(ring), 1)
      landed.push(ring)
    }
    if (landed.length === 0 && lost.length === 0) return
    const is = (group: readonly Ring[], thread: DemoThread, message: DemoMessage): boolean =>
      group.some((ring) => ring.thread === thread.id && ring.message === message.id)
    boxes = boxes.map((box) => ({
      ...box,
      threads: box.threads.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          is(landed, thread, message)
            ? { ...message, state: "delivered" as const, deliveredAt: Date.now() }
            : is(lost, thread, message)
              ? { ...message, state: "gone" as const }
              : message,
        ),
      })),
    }))
    publish()
    for (const ring of landed.toReversed()) ring.delivered?.()
    for (const ring of lost.toReversed()) ring.stopped?.()
  }
  return {
    state,
    record: (item, answer, outcome) => {
      if (item.kind !== "ask" && item.kind !== "update") return
      if (answer && answer.kind !== "ask" && answer.kind !== "update") return
      const { source } = item
      const target = { projectId: source.projectId, workspaceSessionId: source.workspaceSessionId }
      const index = boxes.findIndex(
        (box) =>
          box.target.projectId === target.projectId &&
          box.target.workspaceSessionId === target.workspaceSessionId,
      )
      const box: DemoSessionMessages = boxes[index] ?? { target, terminals: [], threads: [] }
      const id = `t-${item.id.replaceAll("-", "")}`
      const thread = box.threads.find((each) => each.id === id)
      const content = item.kind === "ask" ? item.ask : item.kind === "update" ? item.update : null
      if (!content) return
      const reply = answer?.kind === "ask" ? answer.answer : null
      const option =
        reply?.type === "reply" &&
        reply.option !== null &&
        item.kind === "ask" &&
        item.ask.shape.type === "options"
          ? item.ask.shape.options[reply.option]?.label
          : undefined
      const text = reply
        ? reply.type === "done"
          ? item.kind === "ask" && item.ask.shape.type === "action"
            ? item.ask.shape.doneLabel
            : "Done."
          : [option, reply.text].filter(Boolean).join("\n\n")
        : item.kind === "ask"
          ? askText(item.ask)
          : `${content.subject}\n\n${content.body}`
      const entry: DemoMessage = {
        id: reply ? `answer:${item.id}` : item.id,
        inbox: reply
          ? "answer"
          : item.kind === "ask"
            ? "ask"
            : item.kind === "update" && item.update.type === "done"
              ? "done"
              : "tell",
        ...(!reply ? { inboxState: outcome ?? (answer ? "read" : "open") } : {}),
        from: reply ? { kind: "person" } : partyOf(source.handle),
        to: reply ? partyOf(source.handle) : { kind: "person" },
        text,
        sentAt: reply ? Date.now() : item.at,
        deliveredAt: reply ? null : item.at,
        state: reply ? "queued" : "delivered",
        hop: (thread?.messages.length ?? 0) + 1,
      }
      const messages = [
        ...(thread?.messages ?? [])
          .filter((each) => each.id !== entry.id)
          .map((each) =>
            reply && each.inbox === "ask" ? { ...each, inboxState: "answered" as const } : each,
          ),
        entry,
      ]
      const updated: DemoSessionMessages = {
        ...box,
        terminals: box.terminals.some((each) => each.terminalId === source.terminalId)
          ? box.terminals
          : [
              ...box.terminals,
              { terminalId: source.terminalId, handle: source.handle, agent: true },
            ],
        threads: [
          ...box.threads.filter((each) => each.id !== id),
          {
            id,
            between: [source.handle, "you"],
            hops: messages.length,
            messages,
          },
        ],
      }
      boxes =
        index < 0 ? [...boxes, updated] : boxes.map((each, at) => (at === index ? updated : each))
      publish()
      if (reply)
        setTimeout(() => {
          boxes = boxes.map((each) => ({
            ...each,
            threads: each.threads.map((current) => ({
              ...current,
              messages: current.messages.map((message) =>
                current.id !== id
                  ? message
                  : message.id === entry.id
                    ? {
                        ...message,
                        state: outcome === "undelivered" ? "gone" : "delivered",
                        deliveredAt: outcome === "undelivered" ? null : Date.now(),
                      }
                    : outcome === "undelivered" && message.inbox === "ask"
                      ? { ...message, inboxState: "undelivered" }
                      : message,
              ),
            })),
          }))
          publish()
        }, deliveryMs)
    },
    send: (target, from, to, text, delivered, stopped, idle = false) => {
      const index = boxes.findIndex(
        (box) =>
          box.target.projectId === target.projectId &&
          box.target.workspaceSessionId === target.workspaceSessionId,
      )
      const box = boxes[index]
      if (!box) return false
      const thread = box.threads.find(
        (each) => each.between.includes(from) && each.between.includes(to),
      )
      if (thread && stopBlocks(thread)) return false
      const peer = box.terminals.find((each) => each.handle === to)
      if (peer && !exists(target, peer.terminalId)) return false
      const id = thread?.id ?? `t-${[from, to].toSorted().join("-")}`
      const hop = (thread?.messages.length ?? 0) + 1
      const sent: DemoMessage = {
        id: `${id}-${hop}`,
        hop,
        ...(idle ? { idle: true as const } : {}),
        from: partyOf(from),
        to: partyOf(to),
        text,
        sentAt: Date.now(),
        state: "queued",
        deliveredAt: null,
      }
      const messages = [...(thread?.messages ?? []), sent]
      // A send that would be held is refused once the pair has ten messages waiting held.
      const loopAt = holdHop({
        id,
        between: [from, to],
        hops: messages.length,
        messages,
        releasedAt: thread?.releasedAt,
        holdFrom: thread?.holdFrom,
      })
      if (loopAt !== undefined && sent.hop >= loopAt) {
        const waiting = box.threads
          .filter((each) => each.between.includes(from) && each.between.includes(to))
          .flatMap((each) => each.messages.map((one) => shown(one, each, false)))
          .filter((one) => one.state === "held" && one.held === "release").length
        if (waiting >= heldPerPair) {
          // The refused send uses no hop, but one that would have started the hold still
          // does, at its would-be hop.
          if (thread && holdHop(thread) === undefined) {
            boxes = boxes.map((each, at) =>
              at !== index
                ? each
                : {
                    ...each,
                    threads: each.threads.map((current) =>
                      current.id === id ? { ...current, holdFrom: sent.hop } : current,
                    ),
                  },
            )
            publish()
          }
          return false
        }
      }
      boxes = boxes.map((each, at) =>
        at !== index
          ? each
          : {
              ...each,
              threads: [
                ...each.threads.filter((current) => current.id !== id),
                {
                  id,
                  between: [from, to],
                  hops: messages.length,
                  releasedAt: thread?.releasedAt,
                  holdFrom: thread?.holdFrom,
                  messages,
                },
              ],
            },
      )
      publish()
      const ring: Ring = {
        target,
        thread: id,
        message: sent.id,
        to,
        rung: false,
        delivered,
        stopped,
      }
      rings.push(ring)
      setTimeout(() => {
        ring.rung = true
        land()
      }, rungMs)
      return true
    },
    refresh: land,
    pause: (next) => {
      state.update((current) => ({ ...current, pending: true }))
      setTimeout(() => {
        isPaused = next
        publish()
        land()
      }, pauseMs)
    },
    waits: (key, waits) => {
      const id = companionKeyId(key)
      let found = false
      boxes = boxes.map((box) => ({
        ...box,
        terminals: box.terminals.map((each) => {
          if (companionKeyId({ ...box.target, terminalId: each.terminalId }) !== id) return each
          found = true
          return { ...each, waits }
        }),
      }))
      if (found) {
        publish()
        land()
      }
      return found
    },
    // Thread ids are the demo's own, unique across its sessions.
    release: (thread) => {
      boxes = boxes.map((box) => ({
        ...box,
        threads: box.threads.map((each) =>
          each.id === thread
            ? {
                ...each,
                releasedAt: each.messages.at(-1)?.hop ?? 0,
                holdFrom: undefined,
                stoppedAt: undefined,
              }
            : each,
        ),
      }))
      publish()
      land()
    },
    stop: (thread) => {
      // What `send` queued in the thread, which the stop drops and its sender is told of.
      const dropped = rings.filter((ring) => ring.thread === thread)
      boxes = boxes.map((box) => ({
        ...box,
        threads: box.threads.map((each) =>
          each.id === thread
            ? {
                ...each,
                // A stop ends the hold, as a release does: the next thread counts afresh.
                releasedAt: each.messages.at(-1)?.hop ?? 0,
                holdFrom: undefined,
                stoppedAt: Date.now(),
                messages: each.messages.map((message) =>
                  message.state === "queued" ? { ...message, state: "gone" as const } : message,
                ),
              }
            : each,
        ),
      }))
      publish()
      land()
      for (const ring of dropped) ring.stopped?.()
    },
  }
}

const minutes = (now: number, ago: number): number => now - ago * 60_000

let sequence = 0
const message = (
  now: number,
  ago: number,
  hop: number,
  from: string,
  to: string,
  state: DemoMessage["state"],
  text: string,
): DemoMessage => ({
  id: `m-demo${(sequence += 1)}`,
  hop,
  from: partyOf(from),
  to: partyOf(to),
  text,
  sentAt: minutes(now, ago),
  state,
  deliveredAt: state === "delivered" ? minutes(now, ago - 0.2) : null,
})

// The agents demo's checkout work: Claude Code (moth) and Codex (crow) reviewing each other,
// a test terminal (owl) whose thread goes round the same status while both run the tests, so
// it folds and is never held, a message to the dev server's terminal (fox) whose agent left, a
// word each with the runtime's (kite) and the build's (raven), and a question moth asked the
// person, which they answered. Every other session's Claude Code has had no messages yet.
export const checkoutMessages = (
  now: number,
  targets: readonly WorkspaceTarget[],
): readonly DemoSessionMessages[] =>
  targets.map((target, index) => ({
    target,
    terminals: [
      { terminalId: demoTerminalId(target, 1), handle: "moth", agent: true },
      { terminalId: demoTerminalId(target, 2), handle: "fox", agent: false },
      { terminalId: demoTerminalId(target, 3), handle: "owl", agent: false },
      { terminalId: demoTerminalId(target, 4), handle: "crow", agent: true },
      { terminalId: demoTerminalId(target, 5), handle: "kite", agent: true },
      { terminalId: demoTerminalId(target, 6), handle: "raven", agent: true },
    ],
    threads:
      index > 0
        ? []
        : [
            {
              id: "t-runtime",
              between: ["moth", "kite"],
              hops: 2,
              messages: [
                message(
                  now,
                  40,
                  1,
                  "moth",
                  "kite",
                  "delivered",
                  "Which Node does the payment SDK need?",
                ),
                message(
                  now,
                  38,
                  2,
                  "kite",
                  "moth",
                  "delivered",
                  "18 or newer. We're on 20, so nothing to do.",
                ),
              ],
            },
            {
              id: "t-build",
              between: ["raven", "moth"],
              hops: 1,
              messages: [
                message(
                  now,
                  17,
                  1,
                  "raven",
                  "moth",
                  "delivered",
                  "The bundle grew 41 kB with the summary card. Most of it is the date library.",
                ),
              ],
            },
            // An entry: moth asked the person, who answered, as the runner keeps a thread a
            // entry. Those still open come from the Inbox's items (`demoEntries`). The
            // question is a real one's length, wider than a reply's bubble, as the Messages
            // spec checks the reply's quote of it stays in the chat.
            {
              id: "t-demotaxask",
              between: ["moth", "you"],
              hops: 2,
              messages: [
                {
                  ...message(
                    now,
                    22,
                    1,
                    "moth",
                    "you",
                    "delivered",
                    [
                      "Should the order summary show tax before or after shipping?",
                      "",
                      "The cart adds it after shipping today, so either way one of them changes.",
                      "",
                      "1. After shipping (recommended)",
                      "",
                      "Same as the cart, so the two totals always match.",
                      "",
                      "2. Before shipping",
                      "",
                      "Tax on the items alone, and change the cart to match.",
                    ].join("\n"),
                  ),
                  inbox: "ask",
                  inboxState: "answered",
                },
                {
                  ...message(
                    now,
                    20,
                    2,
                    "you",
                    "moth",
                    "delivered",
                    "After shipping, same as the cart.",
                  ),
                  inbox: "answer",
                },
              ],
            },
            {
              id: "t-review",
              between: ["moth", "crow"],
              hops: 4,
              messages: [
                message(
                  now,
                  9,
                  1,
                  "moth",
                  "crow",
                  "delivered",
                  "Can you review the checkout changes in src/checkout/? The retry logic is new.",
                ),
                message(
                  now,
                  6,
                  2,
                  "crow",
                  "moth",
                  "delivered",
                  "Looking now. submitOrder() retries on every 503 without backing off, so a bad deploy gets hammered.",
                ),
                message(
                  now,
                  3,
                  3,
                  "moth",
                  "crow",
                  "leased",
                  "Fixed: exponential backoff, capped at 5 tries.\nCould you check it again?",
                ),
                message(
                  now,
                  1,
                  4,
                  "moth",
                  "crow",
                  "queued",
                  "tests/checkout/retry.test.ts covers it now; see `maxTries` and the **cap**.",
                ),
              ],
            },
            {
              id: "t-flaky",
              between: ["moth", "owl"],
              hops: 13,
              messages: [
                // The ten before: the two going back and forth over the flaky test. The tests run again
                // between the messages, so none is idle, and a thread of rounds is never held.
                ...Array.from({ length: 10 }, (_, before) =>
                  before % 2 === 0
                    ? message(
                        now,
                        34 - before * 2,
                        before + 1,
                        "owl",
                        "moth",
                        "delivered",
                        `Run ${before / 2 + 1}: cart.spec.ts failed on the coupon case.`,
                      )
                    : message(
                        now,
                        34 - before * 2,
                        before + 1,
                        "moth",
                        "owl",
                        "delivered",
                        "Once more, with the seed logged.",
                      ),
                ),
                message(
                  now,
                  14,
                  11,
                  "owl",
                  "moth",
                  "delivered",
                  "cart.spec.ts failed again on the coupon case.",
                ),
                message(
                  now,
                  13,
                  12,
                  "moth",
                  "owl",
                  "delivered",
                  "Run it ten more times and tell me.",
                ),
                message(
                  now,
                  12,
                  13,
                  "owl",
                  "moth",
                  "queued",
                  "3 of 10 failed. Want me to quarantine it?",
                ),
              ],
            },
            {
              id: "t-server",
              between: ["moth", "fox"],
              hops: 1,
              messages: [
                // Yesterday's.
                message(
                  now,
                  26 * 60,
                  1,
                  "moth",
                  "fox",
                  "gone",
                  "Restart the dev server once the migration lands.",
                ),
              ],
            },
          ],
  }))

// The content preview's two agents: Codex building the studio (moth) asks Claude Code,
// refactoring auth (owl), about the session API, and waits on its answer.
export const studioMessages = (now: number, target: WorkspaceTarget): DemoSessionMessages => ({
  target,
  terminals: [
    { terminalId: demoTerminalId(target, 1), handle: "moth", agent: true },
    { terminalId: demoTerminalId(target, 2), handle: "fox", agent: false },
    { terminalId: demoTerminalId(target, 3), handle: "owl", agent: true },
  ],
  threads: [
    {
      id: "t-auth",
      between: ["moth", "owl"],
      hops: 3,
      messages: [
        message(
          now,
          8,
          1,
          "moth",
          "owl",
          "delivered",
          "Does the auth refactor change how sessions are read? The studio calls getSession() on every page.",
        ),
        message(
          now,
          5,
          2,
          "owl",
          "moth",
          "delivered",
          "Yes: getSession() becomes async and takes the request. I'll keep a sync shim until you've moved over.",
        ),
        message(
          now,
          2,
          3,
          "moth",
          "owl",
          "queued",
          "Thanks. Moving now; I'll tell you when it's done.",
        ),
      ],
    },
  ],
})
