import { randomUUID } from "node:crypto"

import { refusesCommand } from "@novadeck/harness-core/grants"
import {
  agentAsk,
  askAnswer,
  grantCommand,
  hiddenIn,
  inboxEntry,
  inboxTextLimits,
  maxAskOptions,
  maxCommandLines,
  maxGrantCommands,
  maxTurnError,
  maxTurnFilePath,
  maxTurnFiles,
  replyPreviewLength,
  type AgentAsk,
  type AgentName,
  type AskAnswer,
  type Grant,
  type GrantProposal,
  type InboxEntry,
  type TerminalMessages,
} from "@novadeck/protocol"
import { Latest } from "@novadeck/wire/server"
import { z } from "zod"

import { DomainError } from "../errors.js"
import type { RootChange } from "../harnesses/roots.js"
import { logs } from "../log.js"
import { cut, firstFew, shorten } from "../text.js"
import { grantCommandsRefusal } from "./grant-text.js"
import type { MakeGrant } from "./grants.js"
import {
  allowSend,
  byteLength,
  cleanInboxText,
  rates,
  recentSends,
  retentionMs,
  undelivered,
  type Message,
} from "./messages.js"
import type { Report, Reports } from "./peers.js"

const log = logs.for("inbox")

// Resolved entries stay as the Messages pane's history. Only open entries reach Inbox.
export type StoredEntry = InboxEntry & {
  readonly state: "open" | "answered" | "read" | "withdrawn" | "gone"
  readonly settledAt?: number
  /**
   * How a withdrawn ask ended: the person dismissed it, its agent withdrew it, or the
   * person's reply in the terminal did. Such an ask stays listed, settled; one withdrawn
   * before this was recorded has no cause and is not listed.
   */
  readonly cause?: "dismissed" | "withdrawn" | "replied"
  /** Ended for want of its session after a restart, not by a different one: it reopens if it binds. */
  readonly lapsed?: true
  /** A settled ask the person cleared from the Inbox: gone from the listing, still in history. */
  readonly cleared?: true
}
export type InboxRecords = {
  entries(): readonly StoredEntry[]
  saveEntry(entry: StoredEntry): void
  /** Saves the entries in one transaction. */
  saveEntries(entries: readonly StoredEntry[]): void
  answerEntry(entry: StoredEntry, message: Message): void
  removeEntries(ids: readonly string[]): void
}
export const memoryInbox = (): InboxRecords => {
  const entries = new Map<string, StoredEntry>()
  return {
    entries: () => [...entries.values()],
    saveEntry: (entry) => void entries.set(entry.id, entry),
    saveEntries: (all) => {
      for (const entry of all) entries.set(entry.id, entry)
    },
    answerEntry: (entry) => void entries.set(entry.id, entry),
    removeEntries: (ids) => {
      for (const id of ids) entries.delete(id)
    },
  }
}

export type TurnOwner = Omit<InboxEntry, "id" | "at" | "content">
type Owner = TurnOwner
type TurnContent = Extract<InboxEntry["content"], { kind: "turn" }>
/** What a turn entry holds of its end. */
export type TurnFields = Omit<TurnContent, "kind">
type Host = {
  owner(terminalId: string): Owner | undefined
  reply(
    terminalId: string,
    askId: string,
    subject: string,
    text: string,
    commit: (message: Message) => void,
    choice?: { readonly option?: string; readonly action?: string },
  ): void
  changed(terminalId: string): void
  exists(terminalId: string): boolean
  replyState(askId: string): Message | undefined
  forgetReplies(ids: readonly string[]): void
  /**
   * Makes the grant the person's click on a card said (`Grants.make`), and ends one whose
   * answer then could not be saved. Absent where the runner keeps no grants.
   */
  makeGrant?(input: MakeGrant): Grant
  endGrant?(id: string): void
}

const subject = z
  .string()
  .transform(cleanInboxText)
  .pipe(
    z
      .string()
      .trim()
      .min(1)
      .max(inboxTextLimits.line)
      // eslint-disable-next-line no-control-regex -- Subjects must stay one line after cleaning.
      .refine((text) => !/[\r\n\x00-\x1f]/.test(text), "Use one line for the subject"),
  )
const markdown = z.string().max(inboxTextLimits.markdown)
// A command an agent asks the person to run, kept as written, with every part of it in
// sight: refused where it holds a character that draws as nothing, which could push the
// rest past a run of blank rows, or more lines than the person reads before running it.
// The Inbox marks long runs of blank lines and spaces where it shows one.
const command = z
  .string()
  .transform((text) => cleanInboxText(text).trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(inboxTextLimits.command)
      .superRefine((text, context) => {
        const hidden = hiddenIn(text)
        if (hidden)
          context.addIssue({
            code: "custom",
            message: `The command holds a character that draws as nothing (${hidden}); use only characters that show`,
          })
        if (text.split("\n").length > maxCommandLines)
          context.addIssue({
            code: "custom",
            message: `Keep the command to ${maxCommandLines} lines or fewer`,
          })
      }),
  )
const option = z.strictObject({
  label: subject,
  summary: z
    .string()
    .transform(cleanInboxText)
    .pipe(z.string().max(inboxTextLimits.summary))
    .nullable()
    .optional(),
  details: markdown.nullable().optional(),
  code: z.strictObject({ path: subject, text: markdown }).nullable().optional(),
})
// A command an agent asks the person to let this terminal run without asking again: the
// matcher's own refusals apply here too, so the card never offers what could not match.
const approvalCommand = z
  .strictObject({ argv: grantCommand.shape.argv, rest: z.boolean().optional() })
  .transform(({ argv, rest }) => ({ argv, rest: rest ?? false }))
  .superRefine((each, context) => {
    const refusal = refusesCommand(each)
    if (refusal !== undefined)
      context.addIssue({ code: "custom", message: `${each.argv.join(" ")}: ${refusal}` })
  })
const requestedShape = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text") }),
  z.strictObject({
    type: z.literal("options"),
    options: z.array(option).min(1).max(maxAskOptions),
    recommend: z
      .number()
      .int()
      .min(0)
      .max(maxAskOptions - 1)
      .nullable()
      .optional(),
  }),
  z.strictObject({
    type: z.literal("action"),
    command,
    directory: z
      .string()
      .transform(cleanInboxText)
      .pipe(
        z
          .string()
          .max(inboxTextLimits.directory)
          // One line: the rule for what draws as nothing covers every control but a line feed.
          .refine(
            (text) => !text.includes("\n") && !hiddenIn(text),
            "Use one plain line for the folder",
          ),
      )
      .nullable()
      .optional(),
    done_label: subject,
  }),
  z.strictObject({
    type: z.literal("approval"),
    commands: z
      .array(approvalCommand)
      .min(1)
      .max(maxGrantCommands)
      .superRefine((commands, context) => {
        const refusal = grantCommandsRefusal(commands)
        if (refusal !== undefined) context.addIssue({ code: "custom", message: refusal })
      }),
  }),
])
const askRequest = z.strictObject({
  subject,
  body: markdown,
  details: markdown.nullable().optional(),
  hard_to_undo: z.string().max(inboxTextLimits.hardToUndo).nullable().optional(),
  shape: requestedShape.optional(),
})
const tellRequest = z.strictObject({ subject, body: markdown })
const doneRequest = tellRequest
const withdrawRequest = z.strictObject({ withdraw: z.uuid() })
const failure = (error: unknown) => ({
  ok: false as const,
  reason: error instanceof Error ? error.message : "Novadeck couldn't save that item.",
})
const same = (entry: InboxEntry, owner: Owner | undefined): boolean =>
  owner !== undefined &&
  entry.projectId === owner.projectId &&
  entry.workspaceSessionId === owner.workspaceSessionId &&
  entry.agent === owner.agent &&
  entry.sessionId === owner.sessionId

const commandLine = (each: { readonly argv: readonly string[]; readonly rest: boolean }): string =>
  each.argv.join(" ") + (each.rest ? " (followed by anything)" : "")

// A plain-text record of everything the person saw, retained after the sheet clears.
const askText = (ask: AgentAsk): string => {
  const { shape } = ask
  const choices =
    shape.type === "options"
      ? shape.options
          .map((each, index) =>
            [
              `${index + 1}. ${each.label}${shape.recommend === index ? " (recommended)" : ""}`,
              each.summary,
              each.details,
              each.code && `${each.code.path}\n${each.code.text}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          )
          .join("\n\n")
      : shape.type === "action"
        ? [shape.command, shape.directory, shape.doneLabel].filter(Boolean).join("\n")
        : shape.type === "approval"
          ? shape.commands.map(commandLine).join("\n")
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

// A plain-text record of a Grant card, as the person saw it.
const grantText = (proposal: GrantProposal): string =>
  [
    `${grantSubject}: ${proposal.presets.join(", ")}`,
    ...proposal.commands.map(commandLine),
    ...proposal.repos.map((each) => each.repo.url),
    proposal.reason,
  ]
    .filter(Boolean)
    .join("\n")

const fail = (message: string): never => {
  throw new DomainError("ANSWER_FAILED", message)
}

const maxOpenAsks = 50
const maxUnreadTells = 50
/** Unread finished turns kept per terminal: the oldest goes at the 51st. */
export const maxUnreadTurns = 50
export const maxResolvedEntries = 100
export const askSweepMs = 60_000
/**
 * How long after a runner starts an open ask waits for its terminal's session to come back
 * before it ends: a restored terminal resumes its agent and binds the session again within
 * seconds, or never. An ask it ended reopens if that session binds after all.
 */
const askResumeGraceMs = 120_000

const isTurn = (entry: StoredEntry): boolean => entry.content.kind === "turn"
/** Whether the entry waits on the person's answer in its agent's session: an ask or a Grant card. */
const answerable = (entry: StoredEntry): boolean =>
  entry.content.kind === "ask" || entry.content.kind === "grant"
const clipped = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 ? cut(value, max) : null

/**
 * A stored turn entry as today's rules read it: its text cut to the limits, its files
 * capped, unknown keys dropped and an unknown outcome taken as failed, so a limit that
 * tightens later costs an entry nothing. Undefined where it still won't parse.
 */
const clampedTurn = (content: unknown): TurnContent | undefined => {
  if (typeof content !== "object" || content === null) return undefined
  const raw = content as { [key: string]: unknown }
  const files = Array.isArray(raw["files"])
    ? raw["files"].flatMap((file: unknown) => {
        const path = clipped(file, maxTurnFilePath)
        return path ? [path] : []
      })
    : []
  const parsed = inboxEntry.shape.content.safeParse({
    kind: "turn",
    outcome: raw["outcome"] === "completed" ? "completed" : "failed",
    reply: clipped(raw["reply"], replyPreviewLength),
    error: clipped(raw["error"], maxTurnError),
    files: files.slice(0, maxTurnFiles),
  })
  return parsed.success && parsed.data.kind === "turn" ? parsed.data : undefined
}

/** What a Grant card's agent hears it was called, when the person dismisses or answers it. */
const grantSubject = "Your grant proposal"

/** The grants a terminal may propose in an hour. */
export const maxProposals = 3
const recentProposals = (times: readonly number[] | undefined, now: number): readonly number[] =>
  (times ?? []).filter((time) => now - time < 60 * 60_000)

const noticedSubjects = 5

/**
 * Novadeck's notice to an agent whose open asks it took out of the person's Inbox because
 * the person wrote to it in its terminal: one paragraph, in the voice of Novadeck's other
 * notices. The subjects are the agent's own words, shortened and quoted.
 */
export const withdrawnNotice = (subjects: readonly string[]): string => {
  const named = subjects.map((each) => JSON.stringify(shorten(each, 80)))
  const one = subjects.length === 1
  return (
    "Novadeck: automatic notice, not from the user: the user wrote to you, " +
    `so Novadeck took your open ${one ? "ask" : "asks"} out of their Inbox: ` +
    `${firstFew(named, noticedSubjects)}. ` +
    `${one ? "It is" : "They are"} closed and can no longer be answered in the Inbox. ` +
    `Read their message as their reply to ${one ? "it" : "them"}; whatever it leaves open, ` +
    "ask again with the ask tool before ending the turn, rather than saying it waits in the " +
    "Inbox. This notice needs no reply."
  )
}

/**
 * Novadeck's quiet notice to an agent whose open asks the person dismissed from their
 * Inbox without answering: printed beside the agent's next hook answer, waking nothing.
 */
export const dismissedNotice = (
  asks: readonly { readonly subject: string; readonly action: string }[],
): string => {
  const list = firstFew(
    asks.map((each) => JSON.stringify(shorten(each.subject, 80))),
    noticedSubjects,
  )
  const one = asks.length === 1
  const head = "Novadeck: automatic notice, not from the user: the user dismissed "
  const tail = " This notice needs no reply."
  const acts = asks.filter((each) => each.action === "action").length
  if (acts === asks.length)
    return (
      `${head}your ${one ? "ask" : "asks"} ${list} from their Inbox. ` +
      `They won't do ${one ? "it" : "them"} for now: go on without ${one ? "it" : "them"}, ` +
      `or stop at that step and say so.${tail}`
    )
  const options = asks.some((each) => each.action === "options")
  return (
    `${head}your ${one ? "ask" : "asks"} ${list} from their Inbox without answering ` +
    `${one ? "it" : "them"}. Don't read that as an answer` +
    (options ? `: they chose none of ${one ? "its" : "their"} options` : "") +
    `. Take it that they don't need ${one ? "it" : "them"} now, and don't ask ` +
    `${one ? "it" : "them"} again unless ${one ? "it matters" : "they matter"} again.${tail}`
  )
}

export class Inbox {
  private readonly byTerminal = new Map<string, Map<string, StoredEntry>>()
  private readonly open = new Map<string, StoredEntry>()
  private readonly texts = new Map<string, string>()
  private readonly sent = new Map<string, readonly number[]>()
  /** When each terminal proposed grants lately, for `maxProposals` an hour. */
  private readonly proposals = new Map<string, readonly number[]>()
  /** Terminals whose root is a guess, with when the guessing began. */
  private readonly guesses = new Map<string, number>()
  private readonly sweeper: ReturnType<typeof setInterval> | undefined
  private readonly entries = new Map<string, StoredEntry>()
  private readonly readers = new Set<Latest<InboxEntry[]>>()
  /** Since when each terminal with open asks has had no agent bound (from the runner's start). */
  private readonly unbound = new Map<string, number>()
  /** The asks the person dismissed that their terminal's agent session is yet to be told of. */
  private readonly dismissals = new Map<
    string,
    {
      readonly agent: string
      readonly sessionId: string
      readonly asks: { readonly subject: string; readonly action: string }[]
    }
  >()
  private readonly resumeGraceMs: number
  private closed = false
  constructor(
    private readonly host: Host,
    private readonly records: InboxRecords = memoryInbox(),
    private readonly now = Date.now,
    {
      sweepMs = askSweepMs,
      resumeGraceMs = askResumeGraceMs,
    }: { readonly sweepMs?: number; readonly resumeGraceMs?: number } = {},
  ) {
    this.resumeGraceMs = resumeGraceMs
    // An entry stored before the wire's rules tightened would fail every listing it is in,
    // so one the wire refuses now is dropped, not kept.
    const stale: string[] = []
    let stored: readonly StoredEntry[] = []
    this.save(() => {
      stored = records.entries()
    })
    for (const entry of stored) {
      if (entry?.content?.kind === "turn") {
        // Clamped in memory only: a newer runner's fields stay in the records until the
        // entry is next amended.
        const content = clampedTurn(entry.content)
        if (!content) stale.push(entry.id)
        else this.keep({ ...entry, state: "open" as const, content })
      } else if (inboxEntry.shape.content.safeParse(entry?.content).success) this.keep(entry)
      else if (entry?.id) stale.push(entry.id)
    }
    if (stale.length > 0) this.save(() => records.removeEntries(stale))
    this.prune()
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => {
        try {
          this.prune()
        } catch (error) {
          log.error("inbox.prune-failed", "Novadeck could not prune its Inbox history", {
            err: error,
          })
        }
      }, sweepMs)
      this.sweeper.unref()
    }
  }

  call(
    terminalId: string,
    kind: "ask" | "tell" | "done",
    request: unknown,
  ): { ok: true; id: string; withdrawn?: true } | { ok: false; reason: string } {
    if (this.closed) return failure(new Error("Novadeck is stopping."))
    const owner = this.host.owner(terminalId)
    if (!owner)
      return failure(
        new Error(
          "Your agent session has not bound in this terminal yet, so an answer could not reach you.",
        ),
      )
    try {
      const withdrawing = withdrawRequest.safeParse(request)
      if (kind === "ask" && withdrawing.success) {
        const entry = this.entries.get(withdrawing.data.withdraw)
        const mine =
          entry !== undefined &&
          entry.terminalId === terminalId &&
          same(entry, owner) &&
          entry.content.kind === "ask"
        // An ask the person already dismissed is withdrawn quietly: nothing changes.
        if (mine && entry.state === "withdrawn" && entry.cause === "dismissed")
          return { ok: true, id: entry.id, withdrawn: true }
        if (!mine || entry.state !== "open")
          throw new Error("That ask is no longer open in your session.")
        this.put({ ...entry, state: "withdrawn", cause: "withdrawn" })
        this.maintain(terminalId)
        return { ok: true, id: entry.id, withdrawn: true }
      }
      const content =
        kind === "tell"
          ? { kind: "tell" as const, ...tellRequest.parse(request) }
          : kind === "done"
            ? { kind: "done" as const, ...doneRequest.parse(request) }
            : (() => {
                const read = askRequest.parse(request)
                const choice = read.shape ?? { type: "text" as const }
                const normalized =
                  choice.type === "options"
                    ? {
                        ...choice,
                        recommend: choice.recommend ?? null,
                        options: choice.options.map((each) => ({
                          ...each,
                          summary: each.summary ?? null,
                          details: each.details ?? null,
                          code: each.code ?? null,
                        })),
                      }
                    : choice.type === "approval"
                      ? {
                          type: "approval" as const,
                          commands: choice.commands,
                        }
                      : choice.type === "action"
                        ? {
                            type: "action" as const,
                            command: choice.command,
                            directory: choice.directory ?? null,
                            doneLabel: choice.done_label,
                          }
                        : choice
                return {
                  kind: "ask" as const,
                  ask: agentAsk.parse({
                    subject: read.subject,
                    body: read.body,
                    details: read.details ?? null,
                    hardToUndo: read.hard_to_undo ?? null,
                    shape: normalized,
                  }),
                }
              })()
      if (byteLength(JSON.stringify(content)) > 32_768)
        throw new Error(
          "This Inbox item is over 32 KB. Shorten its details or put longer content in a file.",
        )
      const existing = this.byTerminal.get(terminalId)
      // A tentative root can still be corrected back to an earlier session.
      if (!this.guesses.has(terminalId))
        for (const entry of existing?.values() ?? [])
          if (answerable(entry) && entry.state === "open" && !same(entry, owner))
            this.put({ ...entry, state: "gone" })
      const open = [...(existing?.values() ?? [])].filter(
        (each) =>
          each.state === "open" &&
          each.content.kind === kind &&
          (kind !== "ask" || same(each, owner)),
      )
      const cap = kind === "ask" ? maxOpenAsks : maxUnreadTells
      if (open.length >= cap)
        throw new Error(
          kind === "ask"
            ? "You already have 50 open asks in this session. Withdraw one before adding another."
            : "You already have 50 unread updates. Wait for the user to read them before adding another.",
        )
      const at = this.now()
      const times = allowSend(this.sent.get(terminalId) ?? [], at, rates.sender)
      if (!times)
        throw new Error(
          `An agent may create ${rates.sender} Inbox asks or updates a minute. Withdrawals are still available; try again shortly.`,
        )
      const entry: StoredEntry = { id: randomUUID(), ...owner, at, content, state: "open" }
      // The first save of a new ask is not best effort: the agent is told if it can't be kept.
      this.put(entry, false)
      this.sent.set(terminalId, times)
      this.maintain(terminalId)
      return { ok: true, id: entry.id }
    } catch (error) {
      return failure(error)
    }
  }

  list(): InboxEntry[] {
    const exists = this.existence()
    const open: InboxEntry[] = [...this.open.values()]
      .filter(
        (each) =>
          each.state === "open" &&
          (answerable(each)
            ? same(each, this.host.owner(each.terminalId))
            : exists(each.terminalId)),
      )
      .map(({ state: _state, ...entry }) => entry)
    const settled = [...this.entries.values()]
      .filter(
        (each) =>
          each.state === "withdrawn" &&
          each.cause !== undefined &&
          !each.cleared &&
          answerable(each) &&
          exists(each.terminalId),
      )
      .map(({ state: _state, cause, settledAt, lapsed: _lapsed, cleared: _cleared, ...entry }) => ({
        ...entry,
        settled: { how: cause!, at: settledAt ?? entry.at },
      }))
    return [...open, ...settled]
  }

  /**
   * The person dismisses an open ask without answering it: it stays listed, settled, and
   * its agent is told at its next hook (see `dismissed`). Anything but an open ask of the
   * terminal's bound session is NOT_FOUND.
   */
  dismiss(id: string): void {
    if (this.closed) throw new DomainError("CLOSING")
    const entry = this.entries.get(id)
    const owner = entry ? this.host.owner(entry.terminalId) : undefined
    if (!entry || entry.state !== "open" || !answerable(entry) || !owner || !same(entry, owner))
      throw new DomainError("NOT_FOUND", "This ask is not open.")
    this.put({ ...entry, state: "withdrawn", cause: "dismissed" })
    const queued = this.dismissals.get(entry.terminalId)
    const note =
      entry.content.kind === "ask"
        ? { subject: entry.content.ask.subject, action: entry.content.ask.shape.type }
        : { subject: grantSubject, action: "grant" }
    if (queued && queued.agent === owner.agent && queued.sessionId === owner.sessionId)
      queued.asks.push(note)
    else
      this.dismissals.set(entry.terminalId, {
        agent: owner.agent,
        sessionId: owner.sessionId,
        asks: [note],
      })
    this.maintain(entry.terminalId)
  }

  /**
   * Takes settled asks out of the listing; any other id, or an unknown one, is skipped. They
   * stay in the terminal's history until the usual retention drops them.
   */
  clear(ids: readonly string[]): void {
    if (this.closed) throw new DomainError("CLOSING")
    const settled = [...new Set(ids)]
      .map((id) => this.entries.get(id))
      .filter(
        (entry): entry is StoredEntry =>
          entry?.state === "withdrawn" &&
          entry.cause !== undefined &&
          !entry.cleared &&
          answerable(entry),
      )
    if (settled.length === 0) return
    // One save and one listing for the lot, as a read of many.
    const cleared = settled.map((entry) => ({ ...entry, cleared: true as const }))
    this.save(() => this.records.saveEntries(cleared))
    for (const entry of cleared) this.keep(entry)
    for (const terminalId of new Set(cleared.map((entry) => entry.terminalId)))
      this.host.changed(terminalId)
    this.publish()
  }

  /**
   * The notice for an agent session of the asks the person dismissed since its last hook, or
   * undefined when none. Asks of a session other than `agent`'s `sessionId` are dropped
   * unspoken: a new session is never told of an old one's.
   */
  dismissed(terminalId: string, agent: string, sessionId: string): string | undefined {
    const queued = this.dismissals.get(terminalId)
    if (!queued) return undefined
    // While the terminal's session is only a guess, a hook of another one may be the guess's:
    // the notice waits for the session it is for.
    if (this.guesses.has(terminalId) && queued.sessionId !== sessionId) return undefined
    this.dismissals.delete(terminalId)
    if (queued.agent !== agent || queued.sessionId !== sessionId) return undefined
    return dismissedNotice(queued.asks)
  }

  answer(id: string, input: AskAnswer): void {
    if (this.closed) throw new DomainError("CLOSING")
    const entry = this.entries.get(id)
    if (
      !entry ||
      entry.state !== "open" ||
      !answerable(entry) ||
      !same(entry, this.host.owner(entry.terminalId))
    )
      throw new DomainError("CONFLICT", "This ask is no longer waiting in that agent session.")
    const parsed = askAnswer.safeParse(input)
    if (!parsed.success) throw new DomainError("ANSWER_FAILED", "That answer doesn't fit this ask.")
    const answer = parsed.data
    const answered: StoredEntry = { ...entry, state: "answered", settledAt: this.now() }
    const made = this.grantOf(entry, answer)
    const asked = entry.content.kind === "ask" ? entry.content.ask.subject : grantSubject
    if (made) {
      let grant: Grant | undefined
      this.host.reply(
        entry.terminalId,
        entry.id,
        asked,
        made.text,
        (message) => {
          // The grant counts before the reply is saved; one whose reply then fails is ended.
          grant = this.host.makeGrant!(made.grant)
          try {
            // Atomic with the person's reply: a failure refuses the answer, retryable.
            this.records.answerEntry(answered, message)
          } catch (error) {
            this.host.endGrant?.(grant.id)
            throw error
          }
          this.keep(answered)
        },
        {},
      )
      this.changed(entry.terminalId)
      this.maintain(entry.terminalId)
      return
    }
    if (entry.content.kind !== "ask")
      throw new DomainError("ANSWER_FAILED", "That answer doesn't fit this ask.")
    const { ask } = entry.content
    let text: string
    let choice: { readonly option?: string; readonly action?: string } = {}
    if (answer.type === "approve" || answer.type === "grant")
      throw new DomainError("ANSWER_FAILED", "That answer doesn't fit this ask.")
    if (answer.type === "done") {
      if (ask.shape.type !== "action")
        throw new DomainError("ANSWER_FAILED", "This ask has no action to mark done.")
      text = ""
      choice = { action: ask.shape.doneLabel }
    } else {
      const picked = answer.option
      if (picked !== null && (ask.shape.type !== "options" || !ask.shape.options[picked]))
        throw new DomainError("ANSWER_FAILED", "Choose one of this ask's options.")
      const label =
        picked !== null && ask.shape.type === "options" ? ask.shape.options[picked]!.label : ""
      text = answer.text.trim()
      if (label) choice = { option: label }
      if (!text && !label)
        throw new DomainError("ANSWER_FAILED", "Write an answer or choose an option.")
    }
    this.host.reply(
      entry.terminalId,
      entry.id,
      ask.subject,
      text,
      (message) => {
        // Atomic with the person's reply: a failure refuses the answer, retryable.
        this.records.answerEntry(answered, message)
        this.keep(answered)
      },
      choice,
    )
    this.changed(entry.terminalId)
    this.maintain(entry.terminalId)
  }

  /**
   * The grant an answer makes, and the words the agent hears it in, or undefined for an
   * answer that is none: Approve on an `approval` ask, which gives the asking terminal the
   * commands for 1 hour; Grant on a Grant card, which must keep to
   * what the proposal offered (its presets, commands by index, repos among its choices; `withLead`
   * is the person's to tick either way), and makes a team grant. Throws ANSWER_FAILED for an answer
   * that fits neither or reaches beyond the proposal. Only these answers make grants.
   */
  private grantOf(
    entry: StoredEntry,
    answer: AskAnswer,
  ): { readonly grant: MakeGrant; readonly text: string } | undefined {
    const { content } = entry
    if (!this.host.makeGrant) {
      if (answer.type === "approve" || answer.type === "grant") fail("Grants are unavailable.")
      return undefined
    }
    if (content.kind === "ask" && content.ask.shape.type === "approval") {
      if (answer.type !== "approve") return undefined
      const { commands } = content.ask.shape
      if (commands.some((each) => refusesCommand(each) !== undefined))
        fail("Novadeck can't grant one of these commands.")
      return {
        grant: {
          projectId: entry.projectId,
          workspaceSessionId: entry.workspaceSessionId,
          holder: { kind: "terminal", handle: entry.handle },
          presets: [],
          commands,
          repos: [],
          entryId: entry.id,
          proposedBy: entry.handle,
          hours: 1,
        },
        text: `Approved: you may run these commands without asking again for 1 hour. Novadeck tells you what it allows.`,
      }
    }
    if (answer.type === "approve") return fail("This ask has no approval to give.")
    if (content.kind !== "grant") {
      if (answer.type === "grant") fail("This is no Grant card.")
      return undefined
    }
    if (answer.type !== "grant") return fail("Grant or dismiss this card.")
    const { proposal } = content
    const presets = [...new Set(answer.presets)]
    if (presets.some((preset) => !proposal.presets.includes(preset)))
      fail("That grant reaches beyond what was proposed.")
    const indices = [...new Set(answer.commands)]
    if (indices.some((index) => proposal.commands[index] === undefined))
      fail("That grant reaches beyond what was proposed.")
    const commands = indices.toSorted((a, b) => a - b).map((index) => proposal.commands[index]!)
    if (commands.some((each) => refusesCommand(each) !== undefined))
      fail("Novadeck can't grant one of these commands.")
    const chosen = new Set(answer.repos)
    const repos = proposal.repos
      .filter((each) => chosen.has(each.repo.url))
      .map((each) => each.repo)
    if (repos.length !== chosen.size) fail("That grant reaches beyond what was proposed.")
    if (presets.length === 0 && commands.length === 0) fail("Pick something to grant.")
    if (presets.length > 0 && repos.length === 0) fail("Pick a repo for the push and PR grants.")
    return {
      grant: {
        projectId: entry.projectId,
        workspaceSessionId: entry.workspaceSessionId,
        holder: { kind: "team", lead: entry.handle, withLead: answer.withLead },
        presets,
        commands,
        repos: presets.length > 0 ? repos : [],
        entryId: entry.id,
        proposedBy: entry.handle,
        hours: answer.hours,
      },
      text:
        `Granted: your team may do what the grant says, for ${answer.hours} ${answer.hours === 1 ? "hour" : "hours"}. ` +
        "Novadeck tells each teammate itself, and a lead gives none of the user's approvals.",
    }
  }

  /**
   * Puts a lead's proposal of a team grant in the Inbox as a Grant card. One proposal waits
   * at a time for a terminal, and at most `maxProposals` come in an hour. Fails with a reason
   * the agent is told; the card is made by the runner from its own reads, never from text.
   */
  propose(
    terminalId: string,
    proposal: GrantProposal,
  ): { ok: true; id: string } | { ok: false; reason: string } {
    if (this.closed) return failure(new Error("Novadeck is stopping."))
    const owner = this.host.owner(terminalId)
    if (!owner)
      return failure(
        new Error(
          "Your agent session has not bound in this terminal yet, so an answer could not reach you.",
        ),
      )
    const refusal = this.proposalLimit(terminalId, owner)
    if (refusal) return failure(new Error(refusal))
    const at = this.now()
    const entry: StoredEntry = {
      id: randomUUID(),
      ...owner,
      at,
      content: { kind: "grant", proposal },
      state: "open",
    }
    if (!inboxEntry.shape.content.safeParse(entry.content).success)
      return failure(new Error("That grant doesn't fit a card."))
    try {
      this.put(entry, false)
    } catch (error) {
      return failure(error)
    }
    this.proposals.set(terminalId, [...recentProposals(this.proposals.get(terminalId), at), at])
    this.maintain(terminalId)
    return { ok: true, id: entry.id }
  }

  /** Why a terminal may not propose a grant now, or undefined when it may. */
  proposalLimit(terminalId: string, owner = this.host.owner(terminalId)): string | undefined {
    const pending = [...(this.byTerminal.get(terminalId)?.values() ?? [])].some(
      (entry) => entry.state === "open" && entry.content.kind === "grant" && same(entry, owner),
    )
    if (pending)
      return "You already have a grant proposal waiting for the user. Wait for their answer before proposing another."
    if (recentProposals(this.proposals.get(terminalId), this.now()).length >= maxProposals)
      return `You may propose ${maxProposals} grants an hour; try again later.`
    return undefined
  }

  read(ids: readonly string[]): void {
    if (this.closed) throw new DomainError("CLOSING")
    const turns: StoredEntry[] = []
    const tells: StoredEntry[] = []
    const at = this.now()
    for (const id of new Set(ids)) {
      const entry = this.entries.get(id)
      if (entry?.state !== "open") continue
      if (entry.content.kind === "turn") turns.push(entry)
      else if (entry.content.kind === "tell" || entry.content.kind === "done")
        tells.push({ ...entry, state: "read", settledAt: at })
    }
    // A read of many is one removal, one save and one listing; a tell stays as history.
    if (turns.length > 0) this.save(() => this.records.removeEntries(turns.map(({ id }) => id)))
    if (tells.length > 0) this.save(() => this.records.saveEntries(tells))
    this.forgetTurns(turns)
    for (const entry of tells) this.keep(entry)
    for (const terminalId of new Set(tells.map((entry) => entry.terminalId)))
      this.host.changed(terminalId)
    if (turns.length > 0 || tells.length > 0) this.publish()
    this.maintain()
  }

  /**
   * Stores the finished turn that ended at `at` as an entry of `owner`'s terminal, or
   * updates the one stored for that end. `owner` is whose it was when the end was seen.
   * Nothing once closed. The terminal's 51st unread turn removes its oldest.
   */
  recordTurn(owner: Owner, at: number, fields: TurnFields): void {
    if (this.closed) return
    if (this.turnAt(owner.terminalId, at)) {
      this.amendTurn(owner.terminalId, at, fields)
      return
    }
    const entry: StoredEntry = {
      id: randomUUID(),
      ...owner,
      at,
      content: { kind: "turn", ...fields },
      state: "open",
    }
    this.save(() => this.records.saveEntry(entry))
    this.keep(entry)
    const unread = [...(this.byTerminal.get(owner.terminalId)?.values() ?? [])]
      .filter(isTurn)
      .toSorted((a, b) => a.at - b.at)
    const excess = unread.slice(0, Math.max(0, unread.length - maxUnreadTurns))
    if (excess.length > 0) {
      log.warn("inbox.turns-capped", "Novadeck dropped the oldest unread turns of a terminal", {
        data: { count: excess.length },
      })
      this.save(() => this.records.removeEntries(excess.map(({ id }) => id)))
      this.forgetTurns(excess)
    }
    this.publish()
  }

  /**
   * Changes the stored turn that ended at `at` to `fields`, or removes it for null (the end
   * turned out otherwise). Nothing where none is stored, as after it was read.
   */
  amendTurn(terminalId: string, at: number, fields: TurnFields | null): void {
    if (this.closed) return
    const entry = this.turnAt(terminalId, at)
    if (!entry) return
    if (!fields) {
      this.save(() => this.records.removeEntries([entry.id]))
      this.forgetTurns([entry])
      this.publish()
      return
    }
    const content = { kind: "turn" as const, ...fields }
    if (JSON.stringify(content) === JSON.stringify(entry.content)) return
    const next = { ...entry, content }
    this.save(() => this.records.saveEntry(next))
    this.keep(next)
    this.publish()
  }

  /**
   * The person wrote to the terminal's agent in its terminal, in a turn that started at
   * `before`: the session's open asks made earlier, which `withdrawReplied` would take out
   * (tells, done entries and turn entries stay), and the notice naming them for the agent. Nothing
   * changes; undefined when none is open.
   */
  withdrawable(
    terminalId: string,
    before: number,
  ): { readonly asks: readonly string[]; readonly notice: string } | undefined {
    if (this.closed) return undefined
    const owner = this.host.owner(terminalId)
    const taken = [...(this.byTerminal.get(terminalId)?.values() ?? [])]
      .filter(
        (entry) =>
          entry.state === "open" &&
          entry.content.kind === "ask" &&
          same(entry, owner) &&
          entry.at < before,
      )
      .toSorted((a, b) => a.at - b.at)
    if (taken.length === 0) return undefined
    const subjects = taken.flatMap((entry) =>
      entry.content.kind === "ask" ? [entry.content.ask.subject] : [],
    )
    return { asks: taken.map((entry) => entry.id), notice: withdrawnNotice(subjects) }
  }

  /**
   * The agent was told (see `withdrawable`) that the person's prompt took these asks out:
   * those still open in its session are withdrawn as replied, as the agent's own withdrawal
   * does. Any since answered, dismissed, withdrawn or from another session stay as they are.
   */
  withdrawReplied(terminalId: string, ids: readonly string[]): void {
    if (this.closed) return
    const owner = this.host.owner(terminalId)
    let count = 0
    for (const id of ids) {
      const entry = this.entries.get(id)
      if (
        !entry ||
        entry.terminalId !== terminalId ||
        entry.state !== "open" ||
        entry.content.kind !== "ask" ||
        !same(entry, owner)
      )
        continue
      this.put({ ...entry, state: "withdrawn", cause: "replied" })
      count += 1
    }
    if (count === 0) return
    this.maintain(terminalId)
    log.info("inbox.withdrawn", "Novadeck took asks out of the Inbox once their agent was told", {
      data: { terminalId, count, cause: "replied" },
    })
  }

  /**
   * The latest `tell` and the latest `done` of the agent session now bound in the terminal,
   * read or not, while Inbox keeps them, as other agents read them; none of a session before
   * it, and none once closed. With no session bound (as after a runner restart, until its
   * agent binds one), those of `saved`, the session the terminal last worked with.
   */
  reports(terminalId: string, saved?: { agent: AgentName; sessionId: string }): Reports {
    const owner = this.closed ? undefined : this.host.owner(terminalId)
    const sought = this.closed || owner ? undefined : saved
    let tell: Report | null = null
    let done: Report | null = null
    for (const entry of owner || sought ? (this.byTerminal.get(terminalId)?.values() ?? []) : []) {
      const { content } = entry
      if (content.kind !== "tell" && content.kind !== "done") continue
      if (
        sought
          ? entry.agent !== sought.agent || entry.sessionId !== sought.sessionId
          : !same(entry, owner)
      )
        continue
      const report = { subject: content.subject, at: entry.at }
      if (content.kind === "tell" && (!tell || tell.at < report.at)) tell = report
      if (content.kind === "done" && (!done || done.at < report.at)) done = report
    }
    return { tell, done }
  }

  /** Whether a finished turn of the terminal may be stored: Inbox is open and the terminal exists. */
  accepts(terminalId: string): boolean {
    return !this.closed && this.host.exists(terminalId)
  }

  rooted(terminalId: string, changes: readonly RootChange[]): void {
    if (this.closed) return
    for (const change of changes) {
      const guessedAt = this.guesses.get(terminalId)
      if (change.type === "new" ? change.guess : change.type === "corrected" && !change.confirmed)
        this.guesses.set(terminalId, guessedAt ?? this.now())
      else this.guesses.delete(terminalId)
      if (change.type === "corrected" && change.from !== change.root.sessionId) {
        const open = [...(this.byTerminal.get(terminalId)?.values() ?? [])].filter(
          (entry) =>
            entry.state === "open" && answerable(entry) && entry.agent === change.root.agent,
        )
        // An ask dismissed under the guessed session stays quietly withdrawable by the
        // corrected one.
        for (const entry of this.byTerminal.get(terminalId)?.values() ?? [])
          if (
            entry.state === "withdrawn" &&
            entry.cause === "dismissed" &&
            answerable(entry) &&
            entry.agent === change.root.agent &&
            entry.sessionId === change.from
          )
            this.put({ ...entry, sessionId: change.root.sessionId })
        // A dismissal noticed under the guessed session is the corrected one's to be told.
        const queued = this.dismissals.get(terminalId)
        if (queued && queued.agent === change.root.agent && queued.sessionId === change.from)
          this.dismissals.set(terminalId, { ...queued, sessionId: change.root.sessionId })
        const existing = open.filter((entry) => entry.sessionId === change.root.sessionId).length
        const tentative = open
          .filter((entry) => entry.sessionId === change.from)
          .toSorted((a, b) => a.at - b.at)
        const remaining = Math.max(0, maxOpenAsks - existing)
        for (const [index, entry] of tentative.entries())
          this.put(
            index < remaining
              ? { ...entry, sessionId: change.root.sessionId }
              : { ...entry, state: "gone" },
          )
        // The reports made while the guess stood were the corrected session's, as other
        // agents read them; those the guessed session made before were its own.
        for (const entry of this.byTerminal.get(terminalId)?.values() ?? [])
          if (
            (entry.content.kind === "tell" || entry.content.kind === "done") &&
            entry.agent === change.root.agent &&
            entry.sessionId === change.from &&
            guessedAt !== undefined &&
            entry.at >= guessedAt
          )
            this.put({ ...entry, sessionId: change.root.sessionId })
      }
    }
    if (this.guesses.has(terminalId)) {
      this.changed(terminalId)
      return
    }
    this.reconcile(terminalId)
  }

  reconcile(terminalId: string): void {
    if (this.closed) return
    const owner = this.host.owner(terminalId)
    if (!owner) this.guesses.delete(terminalId)
    const exists = this.existence()
    if (!exists(terminalId)) {
      this.dismissals.delete(terminalId)
      const turns = [...(this.byTerminal.get(terminalId)?.values() ?? [])].filter(isTurn)
      if (turns.length > 0) this.save(() => this.records.removeEntries(turns.map(({ id }) => id)))
      this.forgetTurns(turns)
    }
    for (const entry of this.byTerminal.get(terminalId)?.values() ?? []) {
      if (entry.content.kind === "turn") continue
      // The session an ask lapsed for is back: it is answerable again, as it was.
      if (entry.state === "gone" && entry.lapsed && same(entry, owner)) {
        const { settledAt: _settledAt, lapsed: _lapsed, ...reopened } = entry
        this.put({ ...reopened, state: "open" })
        continue
      }
      if (
        entry.terminalId === terminalId &&
        entry.state === "open" &&
        (answerable(entry)
          ? !same(entry, owner) && (!owner || !this.guesses.has(terminalId))
          : !exists(terminalId))
      )
        this.put({ ...entry, state: "gone" })
    }
    this.changed(terminalId)
    this.maintain(terminalId)
  }

  history(terminalId: string, listing: TerminalMessages): TerminalMessages {
    const entries = this.byTerminal.get(terminalId)?.values() ?? []
    const threads = new Map(listing.threads.map((thread) => [thread.id, thread]))
    for (const entry of entries) {
      const content = entry.content
      // Finished turns are not messages.
      if (content.kind === "turn") continue
      const thread = `t-${entry.id.replaceAll("-", "")}`
      const known = threads.get(thread)
      let text = this.texts.get(entry.id)
      if (text === undefined) {
        text =
          content.kind === "ask"
            ? askText(content.ask)
            : content.kind === "grant"
              ? grantText(content.proposal)
              : `${content.subject}\n\n${content.body}`
        this.texts.set(entry.id, text)
      }
      const reply =
        known?.messages.find((message) => message.inbox === "answer") ??
        this.host.replyState(entry.id)
      const inboxState =
        entry.state === "answered" && reply?.state === "gone" && reply.deliveredAt === null
          ? ("undelivered" as const)
          : entry.state === "withdrawn" && entry.cause === "dismissed"
            ? ("dismissed" as const)
            : entry.state
      const trace = {
        id: `m-${entry.id.replaceAll("-", "")}`,
        thread,
        hop: 1,
        from: { kind: "agent" as const, handle: entry.handle, agent: entry.agent },
        to: { kind: "person" as const },
        text,
        sentAt: entry.at,
        state: "delivered" as const,
        held: null,
        deliveredAt: entry.at,
        inbox: content.kind === "grant" ? ("ask" as const) : content.kind,
        inboxState,
      }
      const messages = [trace, ...(known?.messages ?? [])]
      const listed = {
        id: thread,
        peer: { kind: "person" as const },
        hops: messages.length,
        idle: 0,
        held: false,
        heldFor: null,
        stopped: false,
        messages,
      }
      threads.set(thread, listed)
    }
    return {
      ...listing,
      threads: [...threads.values()]
        .toSorted((a, b) => (b.messages.at(-1)?.sentAt ?? 0) - (a.messages.at(-1)?.sentAt ?? 0))
        .slice(0, 1000),
    }
  }

  forgetProject(projectId: string): void {
    const gone = [...this.entries.values()].filter((each) => each.projectId === projectId)
    const terminals = new Set(gone.map((entry) => entry.terminalId))
    for (const id of this.guesses.keys()) {
      const owner = this.host.owner(id)
      if (!owner || owner.projectId === projectId || terminals.has(id)) this.guesses.delete(id)
    }
    for (const id of terminals) this.dismissals.delete(id)
    this.remove(gone)
  }

  prune(terminalId?: string): void {
    if (this.closed) return
    const at = this.now()
    const gone: StoredEntry[] = []
    const groups = terminalId
      ? [...this.byTerminal].filter(([id]) => id === terminalId)
      : [...this.byTerminal]
    this.abandon(groups, at)
    const exists = this.existence()
    for (const [id, entries] of groups) {
      // The latest done of a terminal that still exists outlives its retention, whatever
      // session is bound (none is, at boot): it stands, read or not, until the agent has
      // more to do (`reports`), so one per terminal is kept, until the terminal is closed.
      const standing = exists(id)
        ? [...entries.values()]
            .filter((entry) => entry.content.kind === "done")
            .toSorted((a, b) => b.at - a.at)[0]
        : undefined
      const resolved = [...entries.values()]
        .filter((entry) => entry.state !== "open" && entry !== standing)
        .map((entry) => {
          const reply = this.host.replyState(entry.id)
          return {
            entry,
            reply,
            at: Math.max(
              entry.settledAt ?? entry.at,
              reply?.deliveredAt ?? 0,
              reply?.response?.goneAt ?? 0,
            ),
          }
        })
        .toSorted((a, b) => a.at - b.at)
      const eligible = resolved.filter(({ reply }) => !reply || !undelivered(reply))
      const expired = eligible.filter((candidate) => at - candidate.at >= retentionMs)
      const ids = new Set(expired.map(({ entry }) => entry.id))
      const excess = Math.max(0, resolved.length - ids.size - maxResolvedEntries)
      for (const { entry } of eligible
        .filter((candidate) => !ids.has(candidate.entry.id))
        .slice(0, excess))
        ids.add(entry.id)
      for (const entry of entries.values())
        if (
          ids.has(entry.id) ||
          (!exists(entry.terminalId) &&
            at - (entry.settledAt ?? entry.at) >= retentionMs &&
            !this.host.replyState(entry.id))
        )
          gone.push(entry)
    }
    this.remove(gone)
    for (const [id, times] of this.sent) {
      const recent = recentSends(times, at)
      if (recent.length) this.sent.set(id, recent)
      else this.sent.delete(id)
    }
  }

  async *watch(signal?: AbortSignal): AsyncGenerator<InboxEntry[]> {
    const reader = new Latest<InboxEntry[]>()
    this.readers.add(reader)
    reader.push(this.list())
    const abort = () => reader.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (this.closed || signal?.aborted) reader.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Listings are delivered in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.finish()
      this.readers.delete(reader)
    }
  }

  close(): void {
    this.closed = true
    this.guesses.clear()
    clearInterval(this.sweeper)
    for (const reader of this.readers) reader.finish()
    this.readers.clear()
  }
  /**
   * Ends the open asks of a terminal that has had no agent bound for the grace period after
   * the runner started: the session the restart left them with has not come back. They
   * reopen if it binds later (see `reconcile`); one that binds another ends them for good.
   */
  private abandon(
    groups: readonly (readonly [string, Map<string, StoredEntry>])[],
    at: number,
  ): void {
    for (const [terminalId, entries] of groups) {
      const asks = [...entries.values()].filter(
        (entry) => entry.state === "open" && answerable(entry),
      )
      if (asks.length === 0 || this.host.owner(terminalId) || this.guesses.has(terminalId)) {
        this.unbound.delete(terminalId)
        continue
      }
      const since = this.unbound.get(terminalId) ?? at
      this.unbound.set(terminalId, since)
      if (at - since < this.resumeGraceMs) continue
      for (const entry of asks) this.put({ ...entry, state: "gone", lapsed: true })
      this.unbound.delete(terminalId)
    }
    for (const id of this.unbound.keys()) if (!this.byTerminal.has(id)) this.unbound.delete(id)
  }
  /** Writes to the records; a failure is logged, and the Inbox carries on from memory. */
  private save(work: () => void): void {
    try {
      work()
    } catch (error) {
      log.error("inbox.save-failed", "Novadeck could not save its Inbox", { err: error })
    }
  }
  private maintain(terminalId?: string): void {
    try {
      this.prune(terminalId)
    } catch (error) {
      log.error("inbox.prune-failed", "Novadeck could not prune its Inbox history", { err: error })
    }
  }
  private keep(entry: StoredEntry): void {
    this.entries.set(entry.id, entry)
    const terminal = this.byTerminal.get(entry.terminalId) ?? new Map<string, StoredEntry>()
    terminal.set(entry.id, entry)
    this.byTerminal.set(entry.terminalId, terminal)
    if (entry.state === "open") this.open.set(entry.id, entry)
    else this.open.delete(entry.id)
  }
  private put(entry: StoredEntry, guarded = true): void {
    const saved =
      entry.state !== "open" && this.entries.get(entry.id)?.state === "open"
        ? { ...entry, settledAt: this.now() }
        : entry
    if (guarded) this.save(() => this.records.saveEntry(saved))
    else this.records.saveEntry(saved)
    this.keep(saved)
    this.changed(saved.terminalId)
  }
  private remove(entries: readonly StoredEntry[]): void {
    if (!entries.length) return
    const ids = entries.map((entry) => entry.id)
    this.save(() => this.records.removeEntries(ids))
    this.host.forgetReplies(ids)
    const changed = new Set<string>()
    for (const entry of entries) {
      this.entries.delete(entry.id)
      this.open.delete(entry.id)
      this.texts.delete(entry.id)
      const terminal = this.byTerminal.get(entry.terminalId)
      terminal?.delete(entry.id)
      if (!terminal?.size) this.byTerminal.delete(entry.terminalId)
      changed.add(entry.terminalId)
    }
    for (const id of changed) this.changed(id)
  }
  /** `host.exists`, looked up once per terminal for as long as the returned function is used. */
  private existence(): (terminalId: string) => boolean {
    const known = new Map<string, boolean>()
    return (terminalId) => {
      let found = known.get(terminalId)
      if (found === undefined) known.set(terminalId, (found = this.host.exists(terminalId)))
      return found
    }
  }
  private turnAt(terminalId: string, at: number): StoredEntry | undefined {
    for (const entry of this.byTerminal.get(terminalId)?.values() ?? [])
      if (entry.content.kind === "turn" && entry.at === at) return entry
    return undefined
  }
  /** Forgets turn entries already removed from the records: no message changes, they are no messages. */
  private forgetTurns(entries: readonly StoredEntry[]): void {
    for (const entry of entries) {
      this.entries.delete(entry.id)
      this.open.delete(entry.id)
      const terminal = this.byTerminal.get(entry.terminalId)
      terminal?.delete(entry.id)
      if (!terminal?.size) this.byTerminal.delete(entry.terminalId)
    }
  }
  private changed(terminalId: string): void {
    this.host.changed(terminalId)
    this.publish()
  }
  private publish(): void {
    if (!this.readers.size) return
    const listing = this.list()
    const key = JSON.stringify(listing)
    for (const reader of this.readers) reader.push(listing, key)
  }
}
