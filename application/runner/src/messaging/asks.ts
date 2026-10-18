import { randomUUID } from "node:crypto"

import {
  agentAsk,
  askAnswer,
  hiddenIn,
  inboxLetter,
  maxCommandLines,
  type AgentAsk,
  type AskAnswer,
  type InboxLetter,
  type TerminalMessages,
} from "@novadeck/protocol"
import { Latest } from "@novadeck/wire/server"
import { z } from "zod"

import { DomainError } from "../errors.js"
import type { RootChange } from "../harnesses/roots.js"
import {
  allowSend,
  byteLength,
  cleanInboxText,
  rates,
  retentionMs,
  undelivered,
  type Message,
} from "./mailbox.js"

// Resolved letters stay as the Messages pane's history. Only open letters reach Inbox.
export type Letter = InboxLetter & {
  readonly state: "open" | "answered" | "read" | "withdrawn" | "gone"
  readonly settledAt?: number
  /** Ended for want of its session after a restart, not by a different one: it reopens if it binds. */
  readonly lapsed?: true
}
export type AskRecords = {
  letters(): readonly Letter[]
  saveLetter(letter: Letter): void
  answerLetter(letter: Letter, message: Message): void
  removeLetters(ids: readonly string[]): void
}
export const memoryAsks = (): AskRecords => {
  const letters = new Map<string, Letter>()
  return {
    letters: () => [...letters.values()],
    saveLetter: (letter) => void letters.set(letter.id, letter),
    answerLetter: (letter) => void letters.set(letter.id, letter),
    removeLetters: (ids) => {
      for (const id of ids) letters.delete(id)
    },
  }
}

type Owner = Omit<InboxLetter, "id" | "at" | "content">
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
}

const subject = z
  .string()
  .transform(cleanInboxText)
  .pipe(
    z
      .string()
      .trim()
      .min(1)
      .max(256)
      // eslint-disable-next-line no-control-regex -- Subjects must stay one line after cleaning.
      .refine((text) => !/[\r\n\x00-\x1f]/.test(text), "Use one line for the subject"),
  )
const markdown = z.string().max(16_384)
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
      .max(4096)
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
  summary: z.string().transform(cleanInboxText).pipe(z.string().max(2048)).nullable().optional(),
  details: markdown.nullable().optional(),
  code: z.strictObject({ path: subject, text: markdown }).nullable().optional(),
})
const requestedShape = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text") }),
  z.strictObject({
    type: z.literal("options"),
    options: z.array(option).min(1).max(3),
    recommend: z.number().int().min(0).max(2).nullable().optional(),
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
          .max(1024)
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
])
const askRequest = z.strictObject({
  subject,
  body: markdown,
  details: markdown.nullable().optional(),
  hard_to_undo: z.string().max(2048).nullable().optional(),
  shape: requestedShape.optional(),
})
const tellRequest = z.strictObject({ subject, body: markdown })
const withdrawRequest = z.strictObject({ withdraw: z.uuid() })
const failure = (error: unknown) => ({
  ok: false as const,
  reason: error instanceof Error ? error.message : "Novadeck couldn't save that item.",
})
const same = (letter: InboxLetter, owner: Owner | undefined): boolean =>
  owner !== undefined &&
  letter.projectId === owner.projectId &&
  letter.workspaceSessionId === owner.workspaceSessionId &&
  letter.agent === owner.agent &&
  letter.sessionId === owner.sessionId

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

export const maxOpenAsks = 50
export const maxUnreadTells = 50
export const maxResolvedLetters = 100
export const askSweepMs = 60_000
/**
 * How long after a runner starts an open ask waits for its terminal's session to come back
 * before it ends: a restored terminal resumes its agent and binds the session again within
 * seconds, or never. An ask it ended reopens if that session binds after all.
 */
export const askResumeGraceMs = 120_000

export class Asks {
  private readonly byTerminal = new Map<string, Map<string, Letter>>()
  private readonly open = new Map<string, Letter>()
  private readonly texts = new Map<string, string>()
  private readonly sent = new Map<string, readonly number[]>()
  private readonly guesses = new Set<string>()
  private readonly sweeper: ReturnType<typeof setInterval> | undefined
  private readonly letters = new Map<string, Letter>()
  private readonly readers = new Set<Latest<InboxLetter[]>>()
  /** Since when each terminal with open asks has had no agent bound (from the runner's start). */
  private readonly unbound = new Map<string, number>()
  private readonly resumeGraceMs: number
  private closed = false
  constructor(
    private readonly host: Host,
    private readonly records: AskRecords = memoryAsks(),
    private readonly now = Date.now,
    {
      sweepMs = askSweepMs,
      resumeGraceMs = askResumeGraceMs,
    }: { readonly sweepMs?: number; readonly resumeGraceMs?: number } = {},
  ) {
    this.resumeGraceMs = resumeGraceMs
    // A letter stored before the wire's rules tightened would fail every listing it is in,
    // so one the wire refuses now is dropped, not kept.
    const stale: string[] = []
    let stored: readonly Letter[] = []
    this.save(() => {
      stored = records.letters()
    })
    for (const letter of stored)
      if (inboxLetter.shape.content.safeParse(letter.content).success) this.keep(letter)
      else stale.push(letter.id)
    if (stale.length > 0) this.save(() => records.removeLetters(stale))
    this.prune()
    if (sweepMs > 0) {
      this.sweeper = setInterval(() => {
        try {
          this.prune()
        } catch (error) {
          console.error("Novadeck could not prune its Inbox history:", error)
        }
      }, sweepMs)
      this.sweeper.unref()
    }
  }

  call(
    terminalId: string,
    kind: "ask" | "tell",
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
        const letter = this.letters.get(withdrawing.data.withdraw)
        if (
          !letter ||
          letter.terminalId !== terminalId ||
          !same(letter, owner) ||
          letter.content.kind !== "ask" ||
          letter.state !== "open"
        )
          throw new Error("That ask is no longer open in your session.")
        this.put({ ...letter, state: "withdrawn" })
        this.maintain(terminalId)
        return { ok: true, id: letter.id, withdrawn: true }
      }
      const content =
        kind === "tell"
          ? { kind: "tell" as const, ...tellRequest.parse(request) }
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
        for (const letter of existing?.values() ?? [])
          if (letter.content.kind === "ask" && letter.state === "open" && !same(letter, owner))
            this.put({ ...letter, state: "gone" })
      const open = [...(existing?.values() ?? [])].filter(
        (each) =>
          each.state === "open" &&
          each.content.kind === kind &&
          (kind === "tell" || same(each, owner)),
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
      const letter: Letter = { id: randomUUID(), ...owner, at, content, state: "open" }
      // The first save of a new ask is not best effort: the agent is told if it can't be kept.
      this.put(letter, false)
      this.sent.set(terminalId, times)
      this.maintain(terminalId)
      return { ok: true, id: letter.id }
    } catch (error) {
      return failure(error)
    }
  }

  list(): InboxLetter[] {
    return [...this.open.values()]
      .filter(
        (each) =>
          each.state === "open" &&
          (each.content.kind === "tell"
            ? this.host.exists(each.terminalId)
            : same(each, this.host.owner(each.terminalId))),
      )
      .map(({ state: _state, ...letter }) => letter)
  }

  answer(id: string, input: AskAnswer): void {
    if (this.closed) throw new DomainError("CLOSING")
    const letter = this.letters.get(id)
    if (
      !letter ||
      letter.state !== "open" ||
      letter.content.kind !== "ask" ||
      !same(letter, this.host.owner(letter.terminalId))
    )
      throw new DomainError("CONFLICT", "This ask is no longer waiting in that agent session.")
    const parsed = askAnswer.safeParse(input)
    if (!parsed.success) throw new DomainError("ANSWER_FAILED", "That answer doesn't fit this ask.")
    const answer = parsed.data
    const { ask } = letter.content
    let text: string
    let choice: { readonly option?: string; readonly action?: string } = {}
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
    const answered: Letter = { ...letter, state: "answered", settledAt: this.now() }
    this.host.reply(
      letter.terminalId,
      letter.id,
      ask.subject,
      text,
      (message) => {
        // Atomic with the person's reply: a failure refuses the answer, retryable.
        this.records.answerLetter(answered, message)
        this.keep(answered)
      },
      choice,
    )
    this.changed(letter.terminalId)
    this.maintain(letter.terminalId)
  }

  read(ids: readonly string[]): void {
    if (this.closed) throw new DomainError("CLOSING")
    for (const id of ids) {
      const letter = this.letters.get(id)
      if (letter?.state === "open" && letter.content.kind === "tell")
        this.put({ ...letter, state: "read" })
    }
    this.maintain()
  }

  rooted(terminalId: string, changes: readonly RootChange[]): void {
    if (this.closed) return
    for (const change of changes) {
      if (change.type === "new" ? change.guess : change.type === "corrected" && !change.confirmed)
        this.guesses.add(terminalId)
      else this.guesses.delete(terminalId)
      if (change.type === "corrected" && change.from !== change.root.sessionId) {
        const open = [...(this.byTerminal.get(terminalId)?.values() ?? [])].filter(
          (letter) =>
            letter.state === "open" &&
            letter.content.kind === "ask" &&
            letter.agent === change.root.agent,
        )
        const existing = open.filter((letter) => letter.sessionId === change.root.sessionId).length
        const tentative = open
          .filter((letter) => letter.sessionId === change.from)
          .toSorted((a, b) => a.at - b.at)
        const remaining = Math.max(0, maxOpenAsks - existing)
        for (const [index, letter] of tentative.entries())
          this.put(
            index < remaining
              ? { ...letter, sessionId: change.root.sessionId }
              : { ...letter, state: "gone" },
          )
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
    for (const letter of this.byTerminal.get(terminalId)?.values() ?? []) {
      // The session an ask lapsed for is back: it is answerable again, as it was.
      if (letter.state === "gone" && letter.lapsed && same(letter, owner)) {
        const { settledAt: _settledAt, lapsed: _lapsed, ...reopened } = letter
        this.put({ ...reopened, state: "open" })
        continue
      }
      if (
        letter.terminalId === terminalId &&
        letter.state === "open" &&
        (letter.content.kind === "ask"
          ? !same(letter, owner) && (!owner || !this.guesses.has(terminalId))
          : !this.host.exists(terminalId))
      )
        this.put({ ...letter, state: "gone" })
    }
    this.changed(terminalId)
    this.maintain(terminalId)
  }

  history(terminalId: string, listing: TerminalMessages): TerminalMessages {
    const letters = this.byTerminal.get(terminalId)?.values() ?? []
    const threads = new Map(listing.threads.map((thread) => [thread.id, thread]))
    for (const letter of letters) {
      const thread = `t-${letter.id.replaceAll("-", "")}`
      const known = threads.get(thread)
      const content = letter.content
      let text = this.texts.get(letter.id)
      if (text === undefined) {
        text =
          content.kind === "ask" ? askText(content.ask) : `${content.subject}\n\n${content.body}`
        this.texts.set(letter.id, text)
      }
      const reply =
        known?.messages.find((message) => message.inbox === "answer") ??
        this.host.replyState(letter.id)
      const inboxState =
        letter.state === "answered" && reply?.state === "gone" && reply.deliveredAt === null
          ? ("undelivered" as const)
          : letter.state
      const trace = {
        id: `m-${letter.id.replaceAll("-", "")}`,
        thread,
        hop: 1,
        from: letter.handle,
        fromAgent: letter.agent,
        to: "you",
        toAgent: letter.agent,
        text,
        sentAt: letter.at,
        state: "delivered" as const,
        held: null,
        deliveredAt: letter.at,
        inbox: content.kind,
        inboxState,
      }
      const messages = [trace, ...(known?.messages ?? [])]
      const entry = {
        id: thread,
        peer: "you",
        hops: messages.length,
        allowed: 0,
        held: false,
        stopped: false,
        messages,
      }
      threads.set(thread, entry)
    }
    return {
      ...listing,
      threads: [...threads.values()]
        .toSorted((a, b) => (b.messages.at(-1)?.sentAt ?? 0) - (a.messages.at(-1)?.sentAt ?? 0))
        .slice(0, 1000),
    }
  }

  forgetProject(projectId: string): void {
    const gone = [...this.letters.values()].filter((each) => each.projectId === projectId)
    const terminals = new Set(gone.map((letter) => letter.terminalId))
    for (const id of this.guesses) {
      const owner = this.host.owner(id)
      if (!owner || owner.projectId === projectId || terminals.has(id)) this.guesses.delete(id)
    }
    this.remove(gone)
  }

  prune(terminalId?: string): void {
    if (this.closed) return
    const at = this.now()
    const gone: Letter[] = []
    const groups = terminalId
      ? [...this.byTerminal].filter(([id]) => id === terminalId)
      : [...this.byTerminal]
    this.abandon(groups, at)
    for (const [, letters] of groups) {
      const resolved = [...letters.values()]
        .filter((letter) => letter.state !== "open")
        .map((letter) => {
          const reply = this.host.replyState(letter.id)
          return {
            letter,
            reply,
            at: Math.max(
              letter.settledAt ?? letter.at,
              reply?.deliveredAt ?? 0,
              reply?.response?.goneAt ?? 0,
            ),
          }
        })
        .toSorted((a, b) => a.at - b.at)
      const eligible = resolved.filter(({ reply }) => !reply || !undelivered(reply))
      const expired = eligible.filter((entry) => at - entry.at >= retentionMs)
      const ids = new Set(expired.map(({ letter }) => letter.id))
      const excess = Math.max(0, resolved.length - ids.size - maxResolvedLetters)
      for (const { letter } of eligible
        .filter((entry) => !ids.has(entry.letter.id))
        .slice(0, excess))
        ids.add(letter.id)
      for (const letter of letters.values())
        if (
          ids.has(letter.id) ||
          (!this.host.exists(letter.terminalId) &&
            at - (letter.settledAt ?? letter.at) >= retentionMs &&
            !this.host.replyState(letter.id))
        )
          gone.push(letter)
    }
    this.remove(gone)
    for (const [id, times] of this.sent) {
      const recent = times.filter((time) => at - time < rates.windowMs)
      if (recent.length) this.sent.set(id, recent)
      else this.sent.delete(id)
    }
  }

  async *watch(signal?: AbortSignal): AsyncGenerator<InboxLetter[]> {
    const reader = new Latest<InboxLetter[]>()
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
  private abandon(groups: readonly (readonly [string, Map<string, Letter>])[], at: number): void {
    for (const [terminalId, letters] of groups) {
      const asks = [...letters.values()].filter(
        (letter) => letter.state === "open" && letter.content.kind === "ask",
      )
      if (asks.length === 0 || this.host.owner(terminalId) || this.guesses.has(terminalId)) {
        this.unbound.delete(terminalId)
        continue
      }
      const since = this.unbound.get(terminalId) ?? at
      this.unbound.set(terminalId, since)
      if (at - since < this.resumeGraceMs) continue
      for (const letter of asks) this.put({ ...letter, state: "gone", lapsed: true })
      this.unbound.delete(terminalId)
    }
    for (const id of this.unbound.keys()) if (!this.byTerminal.has(id)) this.unbound.delete(id)
  }
  /** Writes to the records; a failure is logged, and the Inbox carries on from memory. */
  private save(work: () => void): void {
    try {
      work()
    } catch (error) {
      console.error("Novadeck could not save its Inbox:", error)
    }
  }
  private maintain(terminalId?: string): void {
    try {
      this.prune(terminalId)
    } catch (error) {
      console.error("Novadeck could not prune its Inbox history:", error)
    }
  }
  private keep(letter: Letter): void {
    this.letters.set(letter.id, letter)
    const terminal = this.byTerminal.get(letter.terminalId) ?? new Map<string, Letter>()
    terminal.set(letter.id, letter)
    this.byTerminal.set(letter.terminalId, terminal)
    if (letter.state === "open") this.open.set(letter.id, letter)
    else this.open.delete(letter.id)
  }
  private put(letter: Letter, guarded = true): void {
    const saved =
      letter.state !== "open" && this.letters.get(letter.id)?.state === "open"
        ? { ...letter, settledAt: this.now() }
        : letter
    if (guarded) this.save(() => this.records.saveLetter(saved))
    else this.records.saveLetter(saved)
    this.keep(saved)
    this.changed(saved.terminalId)
  }
  private remove(letters: readonly Letter[]): void {
    if (!letters.length) return
    const ids = letters.map((letter) => letter.id)
    this.save(() => this.records.removeLetters(ids))
    this.host.forgetReplies(ids)
    const changed = new Set<string>()
    for (const letter of letters) {
      this.letters.delete(letter.id)
      this.open.delete(letter.id)
      this.texts.delete(letter.id)
      const terminal = this.byTerminal.get(letter.terminalId)
      terminal?.delete(letter.id)
      if (!terminal?.size) this.byTerminal.delete(letter.terminalId)
      changed.add(letter.terminalId)
    }
    for (const id of changed) this.changed(id)
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
