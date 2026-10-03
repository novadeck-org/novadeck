import { z } from "zod"

import { allowOpen } from "./opens.js"

/**
 * What an agent asks to close, through NovaDeck's MCP server: another terminal of its
 * project and session, by its exact handle, as `send` names its recipient.
 */
export const closeRequest = z.strictObject({ to: z.string().min(1).max(64) })

export type CloseRequest = z.infer<typeof closeRequest>

/** Why no terminal closed, in a sentence the agent can act on. */
export type CloseFailure = { readonly ok: false; readonly reason: string }

/**
 * The MCP server's answer: the terminal that closed, by its handle, the agent it ran, if
 * any; the caller's own messages that won't arrive now, told once, as `send` tells them;
 * and how many other agents' messages to it won't either. Or why it didn't close.
 */
export type CloseAnswer =
  | {
      readonly ok: true
      readonly handle: string
      /** The agent that ran there, as agents read its name, such as Codex. */
      readonly ran?: string
      readonly gone?: readonly { readonly id: string; readonly to: string }[]
      /** Messages other terminals sent it, undelivered, which won't arrive now. */
      readonly others?: number
    }
  | CloseFailure

const refused = (reason: string): CloseFailure => ({ ok: false, reason })

/** The request, read strictly, so a failure names what's wrong. */
export const readCloseRequest = (
  value: unknown,
): { readonly ok: true; readonly request: CloseRequest } | CloseFailure => {
  const parsed = closeRequest.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  return refused("A close needs `to`, the exact handle of a terminal, and nothing else.")
}

/** What a terminal's agent hears when it asks to close its own terminal. */
export const selfRefusal = (handle: string): string =>
  `${handle} is your own terminal, which close_terminal never closes; to end your own ` +
  "session, use your harness's own way to exit."

/** What an agent hears once agents have closed as many terminals as they may for now. */
export const spentRefusal =
  "Agents closed as many terminals as they may in the last minute; try again shortly, or " +
  "leave the rest for the user to close."

/**
 * How many terminals one terminal's agents may close within a window, in milliseconds:
 * as many as they may open, from a budget of their own.
 */
export const closeLimit = { count: 5, windowMs: 60_000 } as const

/**
 * How many terminals agents may close across the runner within a window: a backstop for
 * agents in many terminals closing at once, so no runaway loop empties the workspace.
 */
export const runnerCloseLimit = { count: 20, windowMs: 60_000 } as const

/**
 * The times a terminal's agents closed terminals, with one more at `now`, when that stays
 * within `limit`; undefined when it would not. Times past the window drop out.
 */
export const allowClose = (
  times: readonly number[],
  now: number,
  limit: { readonly count: number; readonly windowMs: number } = closeLimit,
): readonly number[] | undefined => allowOpen(times, now, limit)
