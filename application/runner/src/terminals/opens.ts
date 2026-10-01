import { randomUUID } from "node:crypto"

import {
  agentName,
  startupCommand,
  terminalTitle,
  type TerminalRequest,
  type TerminalRequestAnswer,
} from "@novadeck/protocol"
import { z } from "zod"

import { DomainError } from "../errors.js"
import type { SendAnswer } from "../messaging/messaging.js"

/**
 * What an agent asks to open, through NovaDeck's MCP server: a new terminal beside its
 * own, in a folder, absolute or from the terminal's directory, starting a command at its
 * first prompt, or an `agent` with a `message` as its task, with a name; and `focus` when
 * the person asked to see it.
 */
export const openRequest = z
  .strictObject({
    command: startupCommand.optional(),
    agent: agentName.optional(),
    message: z
      .string()
      .max(64 * 1024)
      .optional(),
    cwd: z.string().min(1).max(4096).optional(),
    title: terminalTitle.optional(),
    focus: z.boolean().optional(),
  })
  .refine((request) => (request.agent === undefined) === (request.message === undefined), {
    message: "An agent and its message come together.",
    path: ["agent"],
  })
  .refine((request) => request.agent === undefined || request.command === undefined, {
    message: "A command can't be combined with an agent and its message.",
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
      readonly cwd: string
      readonly command?: string
      /** Where the task sent to an agent it started is, as `send` would answer. */
      readonly task?: SendAnswer
      /**
       * The agent started without its task as its first prompt, as Antigravity in a folder
       * it doesn't trust yet: the task reaches it with the person's first prompt there.
       */
      readonly taskWaits?: true
    }
  | OpenFailure

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
 * How a request went: answered; sent to nobody, as no client follows; or left without an
 * answer, as its client went away or took too long.
 */
export type Asked =
  | { readonly type: "answered"; readonly answer: TerminalRequestAnswer }
  | { readonly type: "nobody" | "gone" | "late" }

/** One `terminals.requests` stream: the requests sent to its client, in order. */
class Follower {
  private readonly queue: TerminalRequest[] = []
  private finished = false
  private wake: (() => void) | undefined

  constructor(readonly owner: string) {}

  get open(): boolean {
    return !this.finished
  }

  push(request: TerminalRequest): void {
    if (this.finished) return
    this.queue.push(request)
    this.notify()
  }

  finish(): void {
    this.finished = true
    this.queue.length = 0
    this.notify()
  }

  async next(): Promise<TerminalRequest | undefined> {
    while (!this.finished && this.queue.length === 0)
      // eslint-disable-next-line no-await-in-loop -- Waits for the next request.
      await new Promise<void>((resolve) => (this.wake = resolve))
    return this.queue.shift()
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * Agents' requests for a new terminal, on their way to the client that lays terminals
 * out. Each goes to the client that subscribed last, which answers it once it has
 * opened the terminal, or says why it didn't.
 */
export class OpenRequests {
  /** Each client's stream, oldest first. */
  private readonly followers: Follower[] = []
  /** Requests waiting for their answer, by id, with the client each went to. */
  private readonly pending = new Map<
    string,
    { readonly owner: string; readonly settle: (asked: Asked) => void }
  >()
  private finished = false

  /**
   * The requests sent to `owner`'s client, until `signal` aborts, the owner is released,
   * or the runner shuts down. Those still waiting once it ends go without an answer.
   */
  async *follow(owner: string, signal?: AbortSignal): AsyncGenerator<TerminalRequest> {
    if (this.finished) throw new DomainError("RUNTIME_CLOSING")
    const follower = new Follower(owner)
    this.followers.push(follower)
    const abort = () => follower.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) follower.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Requests are delivered in order.
        const request = await follower.next()
        if (request === undefined) return
        yield request
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      follower.finish()
      this.followers.splice(this.followers.indexOf(follower), 1)
      this.abandon(owner)
    }
  }

  /** Sends the request to the newest client and waits up to `ms` for its answer. */
  ask(request: Omit<TerminalRequest, "requestId">, ms: number): Promise<Asked> {
    const follower = this.followers.findLast((each) => each.open)
    if (!follower) return Promise.resolve({ type: "nobody" })
    const requestId = randomUUID()
    return new Promise<Asked>((resolve) => {
      const timer = setTimeout(() => settle({ type: "late" }), ms)
      const settle = (asked: Asked) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(asked)
      }
      this.pending.set(requestId, { owner: follower.owner, settle })
      follower.push({ requestId, ...request })
    })
  }

  /** The client's answer; NOT_FOUND once nothing waits for it from this client. */
  answer(answer: TerminalRequestAnswer, owner: string): void {
    const waiting = this.pending.get(answer.requestId)
    if (!waiting || waiting.owner !== owner) throw new DomainError("NOT_FOUND")
    waiting.settle({ type: "answered", answer })
  }

  /** Ends the owner's streams; what they still wait for goes without an answer. */
  release(owner: string): void {
    for (const follower of this.followers) if (follower.owner === owner) follower.finish()
    this.abandon(owner)
  }

  /** Ends every stream, as the runner shuts down. */
  finish(): void {
    this.finished = true
    for (const follower of this.followers) follower.finish()
    for (const { settle } of this.pending.values()) settle({ type: "gone" })
  }

  /** Requests sent to `owner`, unless it still follows on another stream. */
  private abandon(owner: string): void {
    if (this.followers.some((follower) => follower.owner === owner && follower.open)) return
    for (const waiting of this.pending.values())
      if (waiting.owner === owner) waiting.settle({ type: "gone" })
  }
}
