import { z } from "zod"

import { clock } from "../messaging/messages.js"
import { bareHandle, mention } from "./handles.js"
import { allowOpen } from "./opens.js"

/**
 * What an agent asks to close, through Novadeck's MCP server: another terminal of its
 * project and session, by its exact handle, as `send` names its recipient.
 */
const closeRequest = z.strictObject({
  to: z.string().min(1).max(65).transform(bareHandle),
})

type CloseRequest = z.infer<typeof closeRequest>

/** Why no terminal closed, in a sentence the agent can act on. */
type CloseFailure = { readonly ok: false; readonly reason: string }

/**
 * The MCP server's answer: the terminal that closed, by its handle, the agent it ran, if
 * any; the caller's own messages that won't arrive now, told once, as `send` tells them;
 * and how many other agents' messages to it won't either. Or why it didn't close.
 *
 * Two answers are not yet a close: `self`, the caller's own terminal, which closes a
 * moment after the answer; and `asked`, a terminal running an agent the caller doesn't
 * lead, which closes only if the person confirms, and the caller hears either way.
 */
export type CloseAnswer =
  | {
      readonly ok: true
      readonly handle: string
      /** Its title, as the person sees it. */
      readonly title: string
      /** The agent that ran there, as agents read its name, such as Codex. */
      readonly ran?: string
      /** The caller's own terminal, which closes a moment after this answer. */
      readonly self?: true
      /** The person was asked to confirm; the terminal is still open. */
      readonly asked?: true
      readonly gone?: readonly {
        readonly id: string
        readonly to: string
        readonly stopped?: true
        readonly released?: true
      }[]
      /** Messages other terminals sent it, undelivered, which won't arrive now. */
      readonly others?: number
      /** Its messages to the caller not yet delivered, which still arrive, marked closed. */
      readonly coming?: readonly OnTheWay[]
    }
  | CloseFailure

/** A message the closed terminal sent the caller that hasn't reached it: its id and send time. */
export type OnTheWay = {
  readonly id: string
  readonly sent: string
  /** Held for the user's release, or while they paused messaging: it arrives only then. */
  readonly held?: true
}

/** The messages, as a close tells of them: by id, with the time each was sent. */
export const onTheWay = (
  messages: readonly { readonly id: string; readonly sentAt: number; readonly held: boolean }[],
): readonly OnTheWay[] =>
  messages.map(({ id, sentAt, held }) => ({ id, sent: clock(sentAt), ...(held && { held }) }))

// "m-1 (sent 01:48)", "m-1 (sent 01:48) and m-2 (sent 01:49)".
const listed = (messages: readonly OnTheWay[]): string => {
  const each = messages.map(({ id, sent }) => `${id} (sent ${sent})`)
  return each.length === 1 ? each[0]! : `${each.slice(0, -1).join(", ")} and ${each.at(-1)!}`
}

/**
 * What a close tells the caller of the messages the closed terminal sent it that hadn't
 * reached it: they arrive marked so, those held only once the user lets them go. Never
 * "after this": a notice may reach the caller with them, or after.
 */
export const onTheWayLine = (coming: readonly OnTheWay[]): string => {
  const waiting = coming.filter((one) => !one.held)
  const held = coming.filter((one) => one.held)
  const lines = []
  if (waiting.length > 0)
    lines.push(
      waiting.length === 1
        ? `Its message ${listed(waiting)} to you hadn't reached you: it arrives marked as from ` +
            "a closed terminal, and no reply reaches its sender."
        : `Its messages ${listed(waiting)} to you hadn't reached you: they arrive marked as ` +
            "from a closed terminal, and no reply reaches their sender.",
    )
  if (held.length > 0)
    lines.push(
      `Its ${held.length === 1 ? "message" : "messages"} ${listed(held)} to you ` +
        `${held.length === 1 ? "is" : "are"} held by the user in Novadeck: ` +
        `${held.length === 1 ? "it arrives" : "they arrive"} only if they let ` +
        `${held.length === 1 ? "it" : "them"} go, marked as from a closed terminal.`,
    )
  return lines.join(" ")
}

const refused = (reason: string): CloseFailure => ({ ok: false, reason })

/** The request, read strictly, so a failure names what's wrong. */
export const readCloseRequest = (
  value: unknown,
): { readonly ok: true; readonly request: CloseRequest } | CloseFailure => {
  const parsed = closeRequest.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  return refused("A close needs `to`, the exact handle of a terminal, and nothing else.")
}

/**
 * How long a terminal's own close waits after its answer, in milliseconds, so the
 * harness has the tool's result, and usually records it, before its terminal ends: on
 * Windows, Claude Code took longer than half a second to pass it on.
 */
export const selfCloseMs = 1_500

/** What an agent hears when it asks to close a terminal already waiting for the person. */
export const waitingRefusal = (handle: string): string =>
  `${mention(handle)} is already waiting for the user's confirmation to close.`

/** What an agent hears when no window of Novadeck is open to ask the person. */
export const nobodyRefusal = "Novadeck isn't open to ask the user, so nothing closed."

/** How the terminal reads in a notice: its handle, title and the agent that ran there. */
const named = (handle: string, title: string, ran: string | undefined): string =>
  `${mention(handle)} · ${title}` + (ran ? `, which ran ${ran}` : "")

export const notice = "Novadeck: automatic notice, not from the user: "

/** What the asking agent is told once the person answered, or the request ended without them. */
export const closeNotice = {
  confirmed: (
    handle: string,
    title: string,
    ran: string | undefined,
    coming: readonly OnTheWay[] = [],
  ): string =>
    notice +
    `The user confirmed closing ${named(handle, title, ran)}, and it is closed. Messages ` +
    "waiting for it never arrive." +
    (coming.length > 0 ? " " + onTheWayLine(coming) : ""),
  declined: (handle: string, title: string): string =>
    notice + `The user kept ${mention(handle)} · ${title} open: it was not closed.`,
  // Another close, or its own exit, ended it first.
  vanished: (handle: string): string =>
    notice +
    `${mention(handle)} closed, or its shell ended, before the user answered, so there is ` +
    "nothing left to confirm.",
  gone: (handle: string): string =>
    notice +
    `Nothing closed: Novadeck's window went away before the user answered the ask to close ` +
    `${mention(handle)}. Ask again if it still should.`,
}

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
 * How many of those may be teammates the caller leads, counted from the same budget: a lead
 * closes its team once its work is done, while other closes keep `closeLimit`.
 */
export const leadCloseLimit = { count: 15, windowMs: 60_000 } as const

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
