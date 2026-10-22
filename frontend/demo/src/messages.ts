import type { AgentAsk, InboxAnswer, InboxItem } from "@novadeck/core/inbox"
import { companionKeyId } from "@novadeck/core/items"
import {
  noMail,
  type AgentMessage,
  type InboxHistory,
  type MailWaits,
  type MailState,
  type MessageThread,
  type Messages,
  type TerminalMail,
} from "@novadeck/core/messages"
import { createStore } from "@novadeck/core/store"
import type { WorkspaceTarget } from "@novadeck/core/types"

import { demoTerminalId } from "./samples"

// A demo mailbox: threads between the sample terminals, kept the way the runner keeps
// them, so pausing holds what waits and releasing a thread lets it go on, as there.

// How many messages a thread has before the person must release it, and again after.
const hopsPerRelease = 12

// A message as the demo keeps it: where it was before any hold.
export type DemoMessage = Omit<AgentMessage, "state" | "held"> & {
  readonly state: "queued" | "leased" | "delivered" | "gone"
}

export type DemoThread = {
  readonly id: string
  // The two terminals, by handle.
  readonly between: readonly [string, string]
  readonly hops: number
  readonly allowed: number
  readonly messages: readonly DemoMessage[]
}

// A session's terminals that take part: each by id, with its handle and whether an agent
// is there to take messages.
export type DemoMailbox = {
  readonly target: WorkspaceTarget
  readonly terminals: readonly {
    readonly terminalId: string
    readonly handle: string
    readonly agent: boolean
    // Why the doorbell can't ring it, where the debug panel put it so.
    readonly waits?: MailWaits | null
  }[]
  readonly threads: readonly DemoThread[]
}

// As the runner says it: a message still waiting is held while paused, or past the hops
// its thread is allowed.
const shown = (message: DemoMessage, thread: DemoThread, paused: boolean): AgentMessage => {
  const hold = message.inbox
    ? null
    : message.hop > thread.allowed
      ? "release"
      : paused
        ? "paused"
        : null
  return message.state === "queued" && hold
    ? { ...message, state: "held", held: hold }
    : { ...message, held: null }
}

const mailOf = (
  box: DemoMailbox,
  handle: string,
  agent: boolean,
  paused: boolean,
  waits: MailWaits | null,
): TerminalMail => ({
  handle,
  agent,
  waits,
  threads: box.threads
    .filter((thread) => thread.between.includes(handle))
    .map((thread): MessageThread => {
      const messages = thread.messages.map((message) => shown(message, thread, paused))
      return {
        id: thread.id,
        peer: thread.between[0] === handle ? thread.between[1] : thread.between[0],
        hops: thread.hops,
        allowed: thread.allowed,
        held: messages.some((message) => message.held === "release"),
        messages,
      }
    })
    .toSorted((a, b) => (b.messages.at(-1)?.sentAt ?? 0) - (a.messages.at(-1)?.sentAt ?? 0)),
})

const stateOf = (boxes: readonly DemoMailbox[], paused: boolean): MailState => ({
  ...noMail,
  paused,
  terminals: Object.fromEntries(
    boxes.flatMap((box) =>
      box.terminals.map(({ terminalId, handle, agent, waits }) => [
        companionKeyId({ ...box.target, terminalId }),
        mailOf(box, handle, agent, paused, waits ?? null),
      ]),
    ),
  ),
})

// How long a pause takes to reach the demo's stand-in runner, so its view shows one on
// its way.
const pauseMs = 150
export const deliveryMs = 2000

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
  readonly record: (item: InboxItem, answer?: InboxAnswer, outcome?: InboxHistory) => void
}

// Whether a backend's messages are the demo's, which keep a record of what the person answered.
export const isDemoMessages = (messages: Messages | undefined): messages is DemoMessages =>
  messages !== undefined && "record" in messages

export const createDemoMessages = (
  initial: readonly DemoMailbox[],
  paused = false,
): DemoMessages => {
  let boxes = initial
  let isPaused = paused
  const state = createStore(stateOf(boxes, isPaused))
  const publish = (): void => void state.update(() => stateOf(boxes, isPaused))
  return {
    state,
    record: (item, answer, outcome) => {
      if (item.kind !== "ask" && !(item.kind === "update" && item.update.type === "told")) return
      if (answer && answer.kind !== "ask" && answer.kind !== "update") return
      const { source } = item
      const target = { projectId: source.projectId, workspaceSessionId: source.workspaceSessionId }
      const index = boxes.findIndex(
        (box) =>
          box.target.projectId === target.projectId &&
          box.target.workspaceSessionId === target.workspaceSessionId,
      )
      const box: DemoMailbox = boxes[index] ?? { target, terminals: [], threads: [] }
      const id = `t-${item.id.replaceAll("-", "")}`
      const thread = box.threads.find((each) => each.id === id)
      const content =
        item.kind === "ask"
          ? item.ask
          : item.kind === "update" && item.update.type === "told"
            ? item.update
            : null
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
      const letter: DemoMessage = {
        id: reply ? `answer:${item.id}` : item.id,
        inbox: reply ? "answer" : item.kind === "ask" ? "ask" : "tell",
        ...(!reply ? { inboxState: outcome ?? (answer ? "read" : "open") } : {}),
        from: reply ? "you" : source.handle,
        to: reply ? source.handle : "you",
        text,
        sentAt: reply ? Date.now() : item.at,
        deliveredAt: reply ? null : item.at,
        state: reply ? "queued" : "delivered",
        hop: (thread?.messages.length ?? 0) + 1,
      }
      const messages = [
        ...(thread?.messages ?? [])
          .filter((each) => each.id !== letter.id)
          .map((each) =>
            reply && each.inbox === "ask" ? { ...each, inboxState: "answered" as const } : each,
          ),
        letter,
      ]
      const updated: DemoMailbox = {
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
            allowed: 0,
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
                  : message.id === letter.id
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
    pause: (next) => {
      state.update((current) => ({ ...current, pending: true }))
      setTimeout(() => {
        isPaused = next
        publish()
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
      if (found) publish()
      return found
    },
    // Thread ids are the demo's own, unique across its mailboxes.
    release: (thread) => {
      boxes = boxes.map((box) => ({
        ...box,
        threads: box.threads.map((each) =>
          each.id === thread ? { ...each, allowed: each.hops + hopsPerRelease } : each,
        ),
      }))
      publish()
    },
    stop: (thread) => {
      boxes = boxes.map((box) => ({
        ...box,
        threads: box.threads.map((each) =>
          each.id === thread
            ? {
                ...each,
                messages: each.messages.map((message) =>
                  message.state === "queued" ? { ...message, state: "gone" as const } : message,
                ),
              }
            : each,
        ),
      }))
      publish()
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
  from,
  to,
  text,
  sentAt: minutes(now, ago),
  state,
  deliveredAt: state === "delivered" ? minutes(now, ago - 0.2) : null,
})

// The agents demo's checkout work: Claude Code (moth) and Codex (crow) reviewing each other,
// a test terminal (owl) whose thread went back and forth until it needs the person's
// release, and a message to the dev server's terminal (fox) whose agent left. Every other
// session's Claude Code has had no messages yet.
export const checkoutMailboxes = (
  now: number,
  targets: readonly WorkspaceTarget[],
): readonly DemoMailbox[] =>
  targets.map((target, index) => ({
    target,
    terminals: [
      { terminalId: demoTerminalId(target, 1), handle: "moth", agent: true },
      { terminalId: demoTerminalId(target, 2), handle: "fox", agent: false },
      { terminalId: demoTerminalId(target, 3), handle: "owl", agent: false },
      { terminalId: demoTerminalId(target, 4), handle: "crow", agent: true },
    ],
    threads:
      index > 0
        ? []
        : [
            {
              id: "t-review",
              between: ["moth", "crow"],
              hops: 4,
              allowed: hopsPerRelease,
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
              allowed: hopsPerRelease,
              messages: [
                // The ten before: the two going back and forth over the flaky test.
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
              allowed: hopsPerRelease,
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
export const studioMailbox = (now: number, target: WorkspaceTarget): DemoMailbox => ({
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
      allowed: hopsPerRelease,
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
