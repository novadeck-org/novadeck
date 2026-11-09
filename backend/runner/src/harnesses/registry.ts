import { agy } from "@novadeck/harness-agy/index"
import { claude } from "@novadeck/harness-claude/index"
import { codex } from "@novadeck/harness-codex/index"
import type { Harness } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"
import type { KeyKind } from "@novadeck/tui-input"

/** Every harness Novadeck integrates, by the agent name clients know it by. */
export const harnesses: { readonly [agent in AgentName]: Harness } = { claude, codex, agy }

export const agents = Object.keys(harnesses) as AgentName[]

/**
 * The kind of ask `event` is to `agent`'s harness, or undefined where it asks nothing: only
 * the events its profile names, never a name every object carries, such as `constructor`.
 */
export const askOf = (agent: AgentName, event: string): "stop" | "prompt" | "tool" | undefined => {
  const { asks } = harnesses[agent].messaging
  return Object.hasOwn(asks, event) ? asks[event] : undefined
}

/**
 * The kinds of the person's keys as delivery takes them while `waiting`, the requests that
 * hold the agent, wait on them: where every one is a question whose Escape only skips it
 * (Antigravity's, `questionEscape`), the Escape ends no turn and types nothing in the box,
 * so delivery gets no key of it. Anywhere else an Escape may stop the turn.
 */
export const deliveredKeys = (
  agent: AgentName | undefined,
  waiting: readonly { readonly kind: string | null }[],
  keys: readonly { readonly kind: KeyKind }[],
): KeyKind[] => {
  const skips =
    agent !== undefined &&
    harnesses[agent].messaging.questionEscape === "skips" &&
    waiting.length > 0 &&
    waiting.every(({ kind }) => kind === "question")
  return keys.flatMap(({ kind }) => (skips && kind === "escape" ? [] : [kind]))
}
