import { companionKeyId } from "../../model/companion"
import {
  noMail,
  type AgentMessage,
  type MailState,
  type MessageThread,
  type Messages,
  type TerminalMail,
} from "../../model/messages"
import { createStore } from "../../model/store"
import type { WorkspaceTarget } from "../../model/types"
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
  }[]
  readonly threads: readonly DemoThread[]
}

// As the runner says it: a message still waiting is held while paused, or past the hops
// its thread is allowed.
const shown = (message: DemoMessage, thread: DemoThread, paused: boolean): AgentMessage => {
  const hold = message.hop > thread.allowed ? "release" : paused ? "paused" : null
  return message.state === "queued" && hold
    ? { ...message, state: "held", held: hold }
    : { ...message, held: null }
}

const mailOf = (
  box: DemoMailbox,
  handle: string,
  agent: boolean,
  paused: boolean,
): TerminalMail => ({
  handle,
  agent,
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
      box.terminals.map(({ terminalId, handle, agent }) => [
        companionKeyId({ ...box.target, terminalId }),
        mailOf(box, handle, agent, paused),
      ]),
    ),
  ),
})

// How long a pause takes to reach the demo's stand-in runner, so its view shows one on
// its way.
const pauseMs = 150

export const createDemoMessages = (initial: readonly DemoMailbox[], paused = false): Messages => {
  let boxes = initial
  let isPaused = paused
  const state = createStore(stateOf(boxes, isPaused))
  const publish = (): void => void state.update(() => stateOf(boxes, isPaused))
  return {
    state,
    pause: (next) => {
      state.update((current) => ({ ...current, pending: true }))
      setTimeout(() => {
        isPaused = next
        publish()
      }, pauseMs)
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
