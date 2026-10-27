import { randomUUID } from "node:crypto"

import { efforts } from "@novadeck/harness-core/harness"
import {
  agentName,
  agentSessionId,
  startupCommand,
  terminalTitle,
  type AgentName,
  type TerminalRequest,
  type TerminalRequestAnswer,
} from "@novadeck/protocol"
import { z } from "zod"

import { DomainError } from "../errors.js"
import { agentLabel } from "../messaging/messages.js"
import type { SendAnswer } from "../messaging/messaging.js"
import { Followers } from "./followers.js"

/**
 * What an agent asks to open, through Novadeck's MCP server: a new terminal beside its
 * own, in a folder, absolute or from the terminal's directory, starting a command at its
 * first prompt, or an `agent`, which starts at its prompt, or with a `message` as its task,
 * and optionally the `model` and reasoning `effort` it starts with, whether the opener
 * leads it (`lead`, by default when there is a message), and a past `resume` session of
 * that agent to continue; with a name; and `focus` when the person asked to see it.
 */
export const openRequest = z
  .strictObject({
    command: startupCommand.optional(),
    agent: agentName.optional(),
    message: z
      .string()
      .max(64 * 1024)
      .optional(),
    model: z.string().min(1).max(128).optional(),
    effort: z.enum(efforts).optional(),
    lead: z.boolean().optional(),
    resume: agentSessionId.optional(),
    cwd: z.string().min(1).max(4096).optional(),
    title: terminalTitle.optional(),
    focus: z.boolean().optional(),
  })
  .refine(
    (request) =>
      request.agent !== undefined ||
      (request.message === undefined &&
        request.model === undefined &&
        request.effort === undefined &&
        request.lead === undefined &&
        request.resume === undefined),
    {
      message: "A message, model, effort, lead or resume goes with an agent.",
      path: ["agent"],
    },
  )
  .refine((request) => request.agent === undefined || request.command === undefined, {
    message: "A command can't be combined with an agent.",
    path: ["command"],
  })

export type OpenRequest = z.infer<typeof openRequest>

/** Why no terminal opened, in a sentence the agent can act on. */
export type OpenFailure = { readonly ok: false; readonly reason: string }

/**
 * The MCP server's answer: the terminal that opened, its handle for messaging it, where,
 * and what it runs; or why not.
 */
export type OpenAnswer =
  | {
      readonly ok: true
      readonly terminalId: string
      readonly handle?: string
      /** Its title, as the person sees it, such as `claude` before anything names it. */
      readonly title?: string
      readonly cwd: string
      readonly command?: string
      /**
       * Whether the caller leads the agent it started and keeps leading it: false for a
       * plain agent the caller doesn't lead, and for a brief-only lead, which ends once
       * the task (the lead's brief) is delivered. Absent for a plain terminal.
       */
      readonly led?: boolean
      /** The session id of the past session the agent it started resumes. */
      readonly resumed?: string
      /**
       * Where the task sent to an agent it started is, as `send` would answer; absent when
       * it was started without one.
       */
      readonly task?: SendAnswer
      /**
       * The agent started without its task as its first prompt, as Antigravity in a folder
       * it doesn't trust yet: the task reaches it once the person trusts the folder and its
       * prompt shows, rung as any message is.
       */
      readonly taskWaits?: true
    }
  | OpenFailure

/** Why a command that would start an interactive agent session isn't opened by `open_terminal`. */
export const sessionCommandRefusal = (agent: AgentName): string =>
  `That command would start an interactive ${agentLabel(agent)} session, which open_terminal ` +
  "doesn't open: use open_agent, which can also give it a task, a model, a lead and a past " +
  "session to resume. A command that is no session, such as a version or help flag or a " +
  "subcommand, is fine here."

export const refused = (reason: string): OpenFailure => ({ ok: false, reason })

/** The request, read strictly, so a failure names what's wrong. */
export const readOpenRequest = (
  value: unknown,
): { readonly ok: true; readonly request: OpenRequest } | OpenFailure => {
  const parsed = openRequest.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  const [issue] = parsed.error.issues
  if (issue?.path[0] === "command" && issue.code === "invalid_format")
    return refused("The command must be one line, without control characters.")
  if (issue?.code === "custom") return refused(issue.message)
  if (issue?.path[0] === "resume")
    return refused(
      "resume is the id of a past session: letters, digits, dots, dashes and underscores, " +
        "up to 128 characters.",
    )
  if (issue?.path[0] === "effort")
    return refused(
      `effort is one of ${efforts.slice(0, -1).join(", ")} or ${efforts.at(-1)}; leave it out for the agent's default.`,
    )
  const field = issue?.path.join(".")
  return refused(field ? `The request's "${field}" is not valid.` : "The request is not valid.")
}

/** How many terminals one terminal's agents may open within a window, in milliseconds. */
export const openLimit = { count: 5, windowMs: 60_000 } as const

/**
 * How many terminals agents may open across the runner within a window: a backstop for
 * a chain whose new terminal asks before its opener is known.
 */
export const runnerOpenLimit = { count: 20, windowMs: 60_000 } as const

/**
 * The times a terminal's agents opened terminals, with one more at `now`, when that
 * stays within `limit`; undefined when it would not. Times past the window drop out.
 */
export const allowOpen = (
  times: readonly number[],
  now: number,
  limit: { readonly count: number; readonly windowMs: number } = openLimit,
): readonly number[] | undefined => {
  const recent = times.filter((time) => now - time < limit.windowMs)
  return recent.length < limit.count ? [...recent, now] : undefined
}

/**
 * Lets go of the budgets in `budgets` whose every time has passed out of a window of
 * `windowMs` by `now`, so budgets of terminals long gone don't pile up.
 */
export const prune = (budgets: Map<string, readonly number[]>, now: number, windowMs: number) => {
  for (const [key, times] of budgets)
    if (times.every((time) => now - time >= windowMs)) budgets.delete(key)
}

/**
 * Who asked for a terminal: its terminal's handle, the title it asked for, if any, and the
 * command it starts there, whose prompt is never the person's.
 */
export type Opener = {
  readonly by: string
  readonly title?: string
  readonly command?: string
  /**
   * Whether it opened the terminal to lead the agent there: from the start, so the brief it
   * sends next carries the lead mark. A lead that ends once the brief lands (`lead` false
   * with a brief) is led here too, until then.
   */
  readonly leads: boolean
  /** The agent session it resumes there, to claim for the terminal once its shell runs it. */
  readonly resume?: { readonly agent: AgentName; readonly session: string }
}

/**
 * How a request went: answered; sent to nobody, as no client follows; or left without an
 * answer, as its client went away or took too long.
 */
export type Asked =
  | { readonly type: "answered"; readonly answer: TerminalRequestAnswer }
  | { readonly type: "nobody" | "gone" | "late" }

/**
 * Agents' requests for a new terminal, on their way to the client that lays terminals
 * out. Each goes to the client that subscribed last, which answers it once it has
 * opened the terminal, or says why it didn't.
 */
export class OpenRequests {
  /** Each client's stream, oldest first. */
  private readonly followers = new Followers<TerminalRequest>()
  /** Requests waiting for their answer, by id, with the client each went to and who asked. */
  private readonly pending = new Map<
    string,
    {
      readonly owner: string
      readonly sessionId: string
      /** Who asked, until the terminal created for the request takes it. */
      opener: Opener | undefined
      readonly settle: (asked: Asked) => void
    }
  >()

  /**
   * The requests sent to `owner`'s client, until `signal` aborts, the owner is released,
   * or the runner shuts down. Those still waiting once it ends go without an answer.
   */
  follow(owner: string, signal?: AbortSignal): AsyncGenerator<TerminalRequest> {
    return this.followers.follow(owner, (each) => this.abandon(each), signal)
  }

  /**
   * Sends the request to the newest client and waits up to `ms` for its answer; the
   * `opener`, with the title it asked for, waits for the terminal the client creates for it.
   */
  ask(request: Omit<TerminalRequest, "requestId">, ms: number, opener: Opener): Promise<Asked> {
    const follower = this.followers.newest()
    if (!follower) return Promise.resolve({ type: "nobody" })
    const requestId = randomUUID()
    return new Promise<Asked>((resolve) => {
      const timer = setTimeout(() => settle({ type: "late" }), ms)
      const settle = (asked: Asked) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(asked)
      }
      this.pending.set(requestId, {
        owner: follower.owner,
        sessionId: request.sessionId,
        opener,
        settle,
      })
      follower.push({ requestId, ...request })
    })
  }

  /**
   * Who asked for the terminal `owner`'s client creates, in `sessionId`, for a request still
   * waiting: taken by the first terminal created for it, so no other claims it; undefined
   * otherwise, or for a terminal in another session than the request's.
   */
  opener(requestId: string, owner: string, sessionId: string): Opener | undefined {
    const waiting = this.pending.get(requestId)
    if (waiting?.owner !== owner || waiting.sessionId !== sessionId) return undefined
    const { opener } = waiting
    waiting.opener = undefined
    return opener
  }

  /** The client's answer; NOT_FOUND once nothing waits for it from this client. */
  answer(answer: TerminalRequestAnswer, owner: string): void {
    const waiting = this.pending.get(answer.requestId)
    if (!waiting || waiting.owner !== owner) throw new DomainError("NOT_FOUND")
    waiting.settle({ type: "answered", answer })
  }

  /** Ends the owner's streams; what they still wait for goes without an answer. */
  release(owner: string): void {
    this.followers.release(owner)
    this.abandon(owner)
  }

  /** Ends every stream, as the runner shuts down. */
  finish(): void {
    this.followers.finish()
    for (const { settle } of this.pending.values()) settle({ type: "gone" })
  }

  /** Requests sent to `owner`, unless it still follows on another stream. */
  private abandon(owner: string): void {
    if (this.followers.follows(owner)) return
    for (const waiting of this.pending.values())
      if (waiting.owner === owner) waiting.settle({ type: "gone" })
  }
}
