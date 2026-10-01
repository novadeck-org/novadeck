import type { AgentName } from "@novadeck/protocol"

import type { Binding } from "./bindings.js"
import type { HarnessEvent } from "./events.js"
import type { MessagingProfile } from "./harness.js"

/**
 * The root session of a terminal's agent: the session its person works with, as
 * messages, its prompts and its activity are for. Where a harness's hooks name its
 * subagents' sessions as they name its own (`root: "status-line"`, as Antigravity), the
 * root is the conversation its status line names; until one has, it is a guess: the one
 * that bound, then that of the first model call after it bound, or of one messages
 * already wait for. Elsewhere it is the bound session.
 */
export type Root = {
  readonly agent: AgentName
  readonly sessionId: string
  readonly instance: string | null
  readonly source: "binding" | "invocation" | "status-line"
}

/**
 * How the root changed, in order: it `ended` (its instance exited), a `new` session
 * became it (bound, or announced by the harness or its status line), which may be only a
 * `guess`, and is `ready` when its harness announced it at its own input prompt
 * (`atPrompt`); or a guess was `corrected` to another session, or `confirmed` by the
 * status line. Each carries the root after it.
 */
export type RootChange =
  | { readonly type: "ended" }
  | {
      readonly type: "new"
      readonly root: Root
      readonly guess: boolean
      readonly ready: boolean
    }
  | {
      readonly type: "corrected"
      readonly from: string
      readonly root: Root
      readonly confirmed: boolean
    }

// Whether two processes may be the same, where the platform tells either.
const sameProcess = (a: string | null, b: string | null): boolean =>
  a === null || b === null || a === b

/** Whether an event comes from the root session, from its own process where known. */
export const rootedIn = (
  root: Root | null,
  event: {
    readonly agent: AgentName
    readonly sessionId: string
    readonly instance: string | null
  },
): boolean =>
  root !== null &&
  root.agent === event.agent &&
  root.sessionId === event.sessionId &&
  (root.instance === null || event.instance === null || root.instance === event.instance)

/** Whether the root is only a guess, which never makes another session's messages gone. */
export const guessed = (root: Root, mode: MessagingProfile["root"]): boolean =>
  mode === "status-line" && root.source !== "status-line"

/**
 * The root after a report, given the binding it left and the facts it decoded, and how
 * it changed. A new binding, or a session its harness announced, is a new root. Where the
 * root follows the status line, only a status line names a new one; a model call
 * corrects a guess, as one in a conversation `awaited` by messages does.
 */
export const followRoot = (
  current: Root | null,
  binding: Binding | null,
  events: readonly HarnessEvent[],
  input: {
    readonly mode: MessagingProfile["root"]
    readonly statusLine: boolean
    readonly awaited: (sessionId: string) => boolean
  },
): { readonly root: Root | null; readonly changes: readonly RootChange[] } => {
  if (!binding) return { root: null, changes: current ? [{ type: "ended" }] : [] }
  const changes: RootChange[] = []
  let root = current
  const become = (next: Root) => {
    root = next
    // Announced at its prompt by this very report, as the session that bound.
    const ready = events.some(
      (event) =>
        event.type === "session-observed" &&
        event.atPrompt === true &&
        event.agent === next.agent &&
        event.sessionId === next.sessionId,
    )
    changes.push({ type: "new", root: next, guess: guessed(next, input.mode), ready })
  }
  const correct = (sessionId: string, source: Root["source"]) => {
    const from = root!.sessionId
    root = { ...root!, sessionId, source }
    changes.push({ type: "corrected", from, root, confirmed: source === "status-line" })
  }
  if (!root || root.agent !== binding.agent || !sameProcess(root.instance, binding.instance))
    become({
      ...binding,
      source: input.statusLine && input.mode === "status-line" ? "status-line" : "binding",
    })
  else if (input.mode === "binding" && root.sessionId !== binding.sessionId)
    become({ ...binding, source: "binding" })
  if (input.mode === "binding") return { root, changes }
  for (const event of events) {
    const now = root!
    if (event.agent !== now.agent || !sameProcess(now.instance, event.instance)) continue
    if (event.type === "session-observed" && event.root && input.statusLine) {
      // A new conversation its status line names: a /clear, or another resumed.
      if (now.source !== "status-line") correct(event.sessionId, "status-line")
      else if (event.sessionId !== now.sessionId)
        become({ ...now, sessionId: event.sessionId, instance: event.instance })
    }
    if (event.type !== "turn-started" || input.statusLine || now.source === "status-line") continue
    if (now.source === "binding") correct(event.sessionId, "invocation")
    else if (event.sessionId !== now.sessionId && input.awaited(event.sessionId))
      correct(event.sessionId, "invocation")
  }
  return { root, changes }
}
