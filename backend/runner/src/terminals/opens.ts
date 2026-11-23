import { randomUUID } from "node:crypto"

import { efforts } from "@novadeck/harness-core/harness"
import {
  agentName,
  agentSessionId,
  directionMark,
  startupCommand,
  terminalTitle,
  type AgentName,
  type TerminalRequest,
  type TerminalRequestAnswer,
} from "@novadeck/protocol"
import { z } from "zod"

import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import { agentLabel } from "../messaging/messages.js"
import type { SendAnswer } from "../messaging/sending.js"
import { list } from "../text.js"
import type { ClientWindows } from "./client-windows.js"
import { Followers } from "./followers.js"

const log = logs.for("opens")

/**
 * What an agent asks to open, through Novadeck's MCP server: a new terminal beside its
 * own, in a folder, absolute or from the terminal's directory, starting a command at its
 * first prompt, or an `agent`, which starts at its prompt, or with a `message` as its task,
 * and optionally the `model` and reasoning `effort` it starts with, whether the opener
 * leads it (`lead`, by default when there is a message), and a past `resume` session of
 * that agent to continue; with a name; and `focus` when the person asked to see it.
 */
const openRequest = z
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

type OpenRequest = z.infer<typeof openRequest>

/** Why no terminal opened, in a sentence the agent can act on. */
export type OpenFailure = { readonly ok: false; readonly reason: string }

/**
 * The MCP server's answer: the terminal that opened, its handle for messaging it, where,
 * and what it runs; or why not.
 */
export type OpenAnswer =
  | {
      readonly ok: true
      /** The person was asked to approve the command; the terminal opens only if they do. */
      readonly asked: true
      readonly cwd: string
      readonly command: string
    }
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
       * The agent started without its task as its first prompt, as Antigravity does: the
       * task reaches it once its prompt shows (after the person trusts the folder, where it
       * asks them to), rung as any message is.
       */
      readonly taskWaits?: true
    }
  | OpenFailure

// How each harness runs a session on a prompt without its interface.
const printForms: { readonly [agent in AgentName]: string } = {
  claude: "claude -p",
  codex: "codex exec",
  agy: "agy -p",
  opencode: "opencode run",
}

/** Why a command that would run an agent session isn't opened by `open_terminal`. */
export const sessionCommandRefusal = (agent: AgentName): string =>
  `That command would run a ${agentLabel(agent)} session (interactive, or on a prompt such ` +
  `as ${printForms[agent]}), which open_terminal doesn't open: use open_agent, which can also ` +
  "give it a task, a model, a lead and a past session to resume. A command that runs no " +
  "agent, such as a version or help flag or a subcommand like claude mcp list, is fine here."

export const refused = (reason: string): OpenFailure => ({ ok: false, reason })

/** The request, read strictly, so a failure names what's wrong. */
export const readOpenRequest = (
  value: unknown,
): { readonly ok: true; readonly request: OpenRequest } | OpenFailure => {
  const parsed = openRequest.safeParse(value)
  if (parsed.success) return { ok: true, request: parsed.data }
  const [issue] = parsed.error.issues
  if (issue?.path[0] === "command" && issue.code === "invalid_format")
    // What the person is asked to approve must read as it runs: no direction controls.
    return refused(
      directionMark.test(String((value as { command?: unknown }).command))
        ? "The command holds text-direction control characters, which aren't run."
        : "The command must be one line, without control characters.",
    )
  if (issue?.code === "custom") return refused(issue.message)
  if (issue?.path[0] === "resume")
    return refused(
      "resume is the id of a past session: letters, digits, dots, dashes and underscores, " +
        "up to 128 characters.",
    )
  if (issue?.path[0] === "effort")
    return refused(`effort is one of ${list(efforts, "or")}; leave it out for the agent's default.`)
  const field = issue?.path.join(".")
  return refused(field ? `The request's "${field}" is not valid.` : "The request is not valid.")
}

/** How many terminals one terminal's agents may open within a window, in milliseconds. */
export const openLimit = { count: 5, windowMs: 60_000 } as const

/**
 * How many of those may be teammates, agents opened led by their opener, counted from the
 * same budget: a lead starts or rounds out its team at once, while other opens keep
 * `openLimit`, and the runner's own limit still bounds them all.
 */
export const leadOpenLimit = { count: 15, windowMs: 60_000 } as const

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
 * Who asked for a terminal: its terminal's id, the title it asked for, if any, and the
 * command it starts there, whose prompt is never the person's.
 */
export type Opener = {
  readonly by: string
  /** Its handle then, which the title it asked for names as its source. */
  readonly handle: string
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
 * How a request went: answered; made, as the client created its terminal but didn't confirm
 * it in time; sent to nobody, as no client follows; or left without an answer, as its client
 * went away or took too long, with no terminal made for it.
 */
export type Asked =
  | { readonly type: "answered"; readonly answer: TerminalRequestAnswer }
  | { readonly type: "made"; readonly terminalId: string }
  | { readonly type: "nobody" | "gone" | "late" }

/**
 * How much longer than its deadline a request waits by default for the terminal the client is
 * creating for it, as a slow shell start on Windows can outlast the deadline: once made, it is
 * answered as made, so its opener never starts an agent it doesn't know of.
 */
export const creatingMs = 15_000

/** How many answers that came after their request settled are let pass without an error. */
const settledKept = 64

/**
 * Agents' requests for a new terminal, on their way to the client that lays terminals
 * out. Each goes to the client that subscribed last, which answers it once it has
 * opened the terminal, or says why it didn't.
 */
export class OpenRequests {
  /** Each client's stream, oldest first. */
  private readonly followers = new Followers<TerminalRequest>()

  constructor(private readonly windows: () => ClientWindows | undefined = () => undefined) {}

  /** Requests waiting for their answer, by id, with the client each went to and who asked. */
  private readonly pending = new Map<
    string,
    {
      readonly owner: string
      readonly sessionId: string
      /** The terminal whose agent asked. */
      readonly from: string
      /** Who asked, until the terminal created for the request takes it. */
      opener: Opener | undefined
      /** Whether a terminal is being created for it: its opener taken, not yet made. */
      creating: boolean
      /** The terminal made for it, before the client confirmed it. */
      made: string | undefined
      /**
       * Whether it is answered as soon as its terminal's creation ends: its deadline passed,
       * or its client went away, while a terminal was being created for it.
       */
      overdue: boolean
      /** Tells the asker the terminal made for it, as soon as it is made. */
      readonly onMade: ((terminalId: string) => void) | undefined
      readonly settle: (asked: Asked) => void
    }
  >()

  /**
   * Requests settled before their client answered, by id, with the client each went to: its
   * answer, still on its way, is no error. The newest few only.
   */
  private readonly settled = new Map<string, string>()

  /**
   * The requests sent to `owner`'s client, until `signal` aborts, the owner is released,
   * or the runner shuts down. Those still waiting once it ends go without an answer.
   */
  follow(owner: string, signal?: AbortSignal): AsyncGenerator<TerminalRequest> {
    return this.followers.follow(owner, (each) => this.abandon(each), signal)
  }

  /**
   * Sends the request to the client that shows the asking terminal's project, else the one
   * used last, else the newest, and waits up to `ms` for its answer; the
   * `opener`, with the title it asked for, waits for the terminal the client creates for it,
   * and `made` hears of that terminal as soon as the runner has made it, before the client
   * confirms it. Past `ms`, a request whose terminal is made is answered as made; one whose
   * terminal is being made waits for it until `until` (a time), by default `creatingMs` more,
   * and is late after that, its terminal no longer told of; any other is late.
   */
  request(
    request: Omit<TerminalRequest, "requestId">,
    ms: number,
    opener: Opener,
    made?: (terminalId: string) => void,
    until?: number,
  ): Promise<Asked> {
    const follower = this.followers.newest(this.windows()?.choosing(request.sessionId))
    if (!follower) return Promise.resolve({ type: "nobody" })
    const requestId = randomUUID()
    return new Promise<Asked>((resolve) => {
      let timer = setTimeout(() => {
        const waiting = this.pending.get(requestId)
        if (waiting?.made !== undefined) return settle({ type: "made", terminalId: waiting.made })
        if (!waiting?.creating) return settle({ type: "late" })
        waiting.overdue = true
        const left = until === undefined ? creatingMs : until - Date.now()
        timer = setTimeout(() => settle({ type: "late" }), Math.max(0, left))
      }, ms)
      const settle = (asked: Asked) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        if (asked.type !== "answered") this.keepSettled(requestId, follower.owner)
        resolve(asked)
      }
      this.pending.set(requestId, {
        owner: follower.owner,
        sessionId: request.sessionId,
        from: request.from,
        opener,
        creating: false,
        made: undefined,
        overdue: false,
        onMade: made,
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
    if (opener) waiting.creating = true
    return opener
  }

  /**
   * How creating the terminal for a request whose opener it took ended: the terminal made,
   * before the client confirms it, whose asker hears of it at once; or null, as none could be
   * made. A request past its deadline is answered by it.
   */
  created(requestId: string | undefined, terminalId: string | null): void {
    const waiting = requestId === undefined ? undefined : this.pending.get(requestId)
    if (!waiting?.creating) return
    waiting.creating = false
    if (terminalId === null) {
      if (waiting.overdue) waiting.settle({ type: "late" })
      return
    }
    waiting.made = terminalId
    try {
      waiting.onMade?.(terminalId)
    } catch (error) {
      // The terminal is made all the same: the create it ends must not fail for it.
      log.error("opens.made-failed", "Novadeck could not take up a terminal opened for an agent", {
        err: error,
      })
    }
    if (waiting.overdue) waiting.settle({ type: "made", terminalId })
  }

  /**
   * The client's answer; NOT_FOUND once nothing waits for it from this client, unless it
   * comes after its request settled without it, when it needs nothing.
   */
  answer(answer: TerminalRequestAnswer, owner: string): void {
    const waiting = this.pending.get(answer.requestId)
    if (!waiting && this.settled.get(answer.requestId) === owner) {
      this.settled.delete(answer.requestId)
      return
    }
    if (!waiting || waiting.owner !== owner) throw new DomainError("NOT_FOUND")
    waiting.settle({ type: "answered", answer })
  }

  /** Whether a request of the terminal's agent for a new terminal is on its way. */
  involves(terminalId: string): boolean {
    return [...this.pending.values()].some((waiting) => waiting.from === terminalId)
  }

  /** Whether a request waits for its terminal, asked by the terminal with that id. */
  asked(terminalId: string): boolean {
    for (const { opener } of this.pending.values()) if (opener?.by === terminalId) return true
    return false
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

  private keepSettled(requestId: string, owner: string): void {
    this.settled.set(requestId, owner)
    for (const oldest of this.settled.keys()) {
      if (this.settled.size <= settledKept) break
      this.settled.delete(oldest)
    }
  }

  /** Requests sent to `owner`, unless it still follows on another stream. */
  private abandon(owner: string): void {
    if (this.followers.follows(owner)) return
    // One whose terminal the runner already made opened all the same; one it is making is
    // answered once that ends, within its deadline.
    for (const waiting of this.pending.values())
      if (waiting.owner !== owner) continue
      else if (waiting.made !== undefined)
        waiting.settle({ type: "made", terminalId: waiting.made })
      else if (waiting.creating) waiting.overdue = true
      else waiting.settle({ type: "gone" })
  }
}
