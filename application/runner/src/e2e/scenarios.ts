import type { MessageState } from "@novadeck/protocol"

import { doorbell } from "../harnesses/harness.js"
import type { AgentSetup } from "./agents/agent.js"
import type { DeckTerminal } from "./deck.js"
import type { E2E } from "./fixture.js"
import { named, wanted, type Reach, type ReachOptions, type Snapshot } from "./history.js"
import { turnEnds } from "./known-gaps.js"
import { asked, latest, tool, type Call, type Rule } from "./model/script.js"

/**
 * What the scenarios share, whichever harness they run: starting a terminal and taking a
 * turn, the rules an agent's turns follow, what NovaDeck's state goes through, and what a
 * call delivered.
 */

/**
 * The screens a harness shows before its prompt when something isn't seeded: trust,
 * hook review, update, sign-in, theme and key screens.
 */
export const startupScreens =
  /trust this folder|Do you trust|Hooks need review|Update available|Sign in with|Log ?in with|Select login method|Authentication required|color scheme|Choose the text style|use this API key/i

/** Opens a terminal running the harness and waits until NovaDeck sees it Ready. */
export const start = async ({ deck }: E2E, setup: AgentSetup): Promise<DeckTerminal> => {
  const terminal = await deck.open(setup.agent)
  await terminal.reached("ready", { timeoutMs: 60_000 })
  return terminal
}

/** A turn's end, as NovaDeck may see it for the harness (see known-gaps.ts). */
export const ended = (setup: AgentSetup): Reach =>
  named(`its turn's end (${turnEnds(setup).join(" or ")})`, (snapshot) =>
    turnEnds(setup).includes(snapshot.delivery),
  )

/** A snapshot holding a message from `from` to `to` in `state`. */
export const holds = (from: string, to: string, state: MessageState): Reach =>
  named(`${from} → ${to} ${state}`, (snapshot) =>
    snapshot.messages.some(
      (message) => message.from === from && message.to === to && message.state === state,
    ),
  )

/**
 * Waits until the terminal's history has gone through each step in order, from `after`
 * on, whatever came between them, and returns the snapshot of the last. Each step is met
 * at or after the one before: changes the runner makes in one handling come as one
 * snapshot, so two steps may be met by the same. A failure says which steps were met and
 * every transition from `after` on.
 */
export const through = async (
  terminal: Pick<DeckTerminal, "reached">,
  steps: readonly Reach[],
  { after = 0, timeoutMs }: ReachOptions = {},
): Promise<Snapshot | undefined> => {
  let last: Snapshot | undefined
  for (const [index, step] of steps.entries()) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Each step is looked for after the one before.
      last = await terminal.reached(step, {
        after: last ? last.index : after,
        since: after,
        ...(timeoutMs !== undefined && { timeoutMs }),
      })
    } catch (error) {
      const met = steps.slice(0, index).map(wanted).join(", ") || "none"
      throw new Error(`met: ${met}; waiting for: ${wanted(step)}. ${(error as Error).message}`, {
        cause: error,
      })
    }
  }
  return last
}

/**
 * Submits a prompt the model answers by showing `shows`, and waits until the turn has
 * worked and ended, as NovaDeck saw it.
 */
export const turn = async (
  terminal: DeckTerminal,
  setup: AgentSetup,
  prompt: string,
  shows: string,
): Promise<void> => {
  const mark = terminal.mark()
  await terminal.submit(prompt)
  await terminal.until(shows)
  await through(terminal, ["working", ended(setup)], { after: mark })
}

/** A rule for the agent's own turns, never a call the harness makes for itself, as a title. */
export const own =
  (rule: Rule): Rule =>
  (call) =>
    call.side ? undefined : rule(call)

/** Answers the agent's first look at a user turn holding `text` with `reply`. */
export const replies = (text: string, reply: string): Rule =>
  own((call) => (asked(call, text) ? { text: reply } : undefined))

/**
 * Answers the agent's first look at a user turn holding `text` by sending `message` to
 * `to`. The calls after the tool answered go to the next rules.
 */
export const sends = (text: string, to: string, message: string): Rule =>
  own((call) => {
    const send = tool(call, "send")
    if (!send || !asked(call, text)) return undefined
    return { calls: [{ name: send, input: { to, text: message } }] }
  })

/** Whether the call is the agent's next look after its send to `to` went. */
export const sent = (call: Call, to: string): boolean => {
  const last = call.turns.at(-1)
  return last?.role === "tool" && last.text.includes(` to ${to} is queued`)
}

/** The doorbell's line, whatever its nonce (see docs/agent-messaging.md). */
export const ring = new RegExp(doorbell.source)

/** One message a delivery carried, as its recipient's model read it. */
export type Delivery = { readonly from: string; readonly text: string }

const entities: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
}

// One level of HTML escaping undone, in a single pass so `&amp;lt;` becomes `&lt;`.
const unescape = (text: string): string =>
  text.replace(
    /&(lt|gt|amp|quot|apos|#39|#x27);/g,
    (whole, name: string) => entities[name] ?? whole,
  )

const block = /<novadeck-messages\b[^>]*>[\s\S]*?<\/novadeck-messages>/g
const escapedBlock = /&lt;novadeck-messages\b[\s\S]*?&lt;\/novadeck-messages&gt;/g
const message = /<message\b([^>]*)>([\s\S]*?)<\/message>/g

const messagesIn = (wrapped: string): Delivery[] =>
  [...wrapped.matchAll(message)].map(([, attributes = "", text = ""]) => ({
    from: /\bfrom="([^"]*)"/.exec(attributes)?.[1] ?? "",
    text: unescape(text),
  }))

/**
 * The messages the call's latest user turn delivered, in order, as NovaDeck wraps them in
 * `<novadeck-messages>`: beside a prompt, as a hook adds them, or HTML-escaped inside a
 * Codex Stop hook's continuation. Text that only looks like a wrapper inside a message
 * stays that message's text.
 */
export const deliveries = (call: Call): Delivery[] => {
  const text = latest(call)
  const plain = [...text.matchAll(block)].map(([wrapped]) => wrapped)
  const rest = text.replace(block, "")
  const escaped = [...rest.matchAll(escapedBlock)].map(([wrapped]) => unescape(wrapped))
  return [...plain, ...escaped].flatMap(messagesIn)
}

/** Whether the call's latest user turn delivered a message from `from`. */
export const delivered = (call: Call, from: string): boolean =>
  !call.side && deliveries(call).some((one) => one.from === from)

/** Every message a terminal sent or received, oldest first within each thread. */
export const messages = (terminal: DeckTerminal) =>
  terminal.messages().threads.flatMap((thread) => thread.messages)
