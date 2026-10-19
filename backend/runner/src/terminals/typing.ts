import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import type { ActivityEvent } from "@novadeck/harness-core/events"
import type { InterruptResult, RequestAnswer } from "@novadeck/protocol"
import { noHold } from "@novadeck/terminal/host"
import { InputQueue } from "@novadeck/tui-input"
import type { HoldBudget, InputHold, InterruptOptions, PromptOptions } from "@novadeck/tui-input"
import { isEmpty, type BoxProfile } from "@novadeck/tui-input/box"

import { DomainError } from "../errors.js"
import type { Activity } from "../harnesses/activity.js"
import { requestRef } from "../harnesses/detail.js"
import { harnesses } from "../harnesses/registry.js"
import { Doorbell, type DoorbellOptions } from "../messaging/doorbell.js"
import type { Messaging } from "../messaging/messaging.js"
import { Answers, type AnswerOptions } from "./answers.js"
import { Dialogs, type DialogsOptions } from "./dialogs.js"
import { Interrupts, Prompts } from "./prompting.js"
import type { Record } from "./record.js"
import { agentWorking, doorbellHost, profileOf } from "./ringing.js"

/** How long `settleBox` looks at a screen for an empty box, in milliseconds. */
const boxSettleMs = 5_000

export type TypingOptions = {
  readonly platform: NodeJS.Platform
  /** How the doorbell rings idle agents; it never rings with `false`, as in some tests. */
  readonly doorbell?: DoorbellOptions | false | undefined
  readonly prompts?: PromptOptions | undefined
  /** How interrupts wait; the queued turn's wait defaults from the platform. */
  readonly interrupts: InterruptOptions
  readonly answers?: (AnswerOptions & DialogsOptions) | undefined
}

export type TypingHost = {
  /** The runner is stopping: nothing more is typed. */
  readonly stopping: () => boolean
  /** The record of a terminal the runner holds, or TERMINAL_NOT_FOUND. */
  readonly record: (terminalId: string) => Record
  /** The record of a terminal the runner holds, running or retained, if it does. */
  readonly held: (terminalId: string) => Record | undefined
  /** The record of a terminal that is running, if it is. */
  readonly live: (terminalId: string) => Record | undefined
  /** TERMINAL_EXITED unless the terminal still runs. */
  readonly running: (record: Record) => void
  /** What the keys typed into a terminal do beyond reaching it (the manager's `keyed`). */
  readonly keyed: (record: Record, data: string) => void
  /** Applies a fact of the bound session's; true when it changed. */
  readonly applyFact: (record: Record, fact: ActivityEvent) => boolean
  /** Shows the bound agent and its activity in the summary, announcing a change. */
  readonly publishAgent: (record: Record, moved: boolean) => void
  /** Tells the terminal's detail readers of a change. */
  readonly detailed: (record: Record) => void
  /** Ends the binding of an agent known to have exited. */
  readonly endExited: (record: Record) => void
  /** Runs `work` in the terminal's turn of reports, after what is queued there. */
  readonly queued: (terminalId: string, work: () => void) => void
  /** Whether process `pid` still runs. */
  readonly alive: (pid: string) => boolean
  readonly messaging: () => Messaging
}

/**
 * Everything that types into terminals' agents, through one input queue per terminal so
 * none types at once: the doorbell's rings, prompts the chat gives, interrupts, and the
 * answers to requests through their dialogs, with the dialogs it reads. One queue for all
 * of them, so a prompt and a ring never type at once.
 */
export class Typing {
  /** Each terminal's input queue: every piece of work that puts keys in its agent's box. */
  readonly inputs: InputQueue
  /** Wakes idle agents for their messages; none when switched off. */
  readonly doorbell: Doorbell | undefined
  readonly prompts: Prompts
  readonly interrupts: Interrupts
  /** Answers requests through their dialogs. */
  answers: Answers
  /** The dialogs of requests, as `agents.detail` shows them. */
  readonly dialogs: Dialogs
  /** The terminals whose box `settleBox` is looking at. */
  private readonly settling = new Set<string>()

  constructor(
    options: TypingOptions,
    readonly host: TypingHost,
  ) {
    const messaging = host.messaging()
    this.inputs = new InputQueue({
      hold: (terminalId, budget) => this.holdInput(terminalId, budget),
    })
    this.doorbell =
      options.doorbell === false
        ? undefined
        : new Doorbell(this.ringHost(), this.inputs, {
            platform: options.platform,
            ...options.doorbell,
          })
    this.prompts = new Prompts(this.promptHost(), this.inputs, options.prompts)
    this.interrupts = new Interrupts(this.interruptHost(), options.interrupts)
    this.dialogs = new Dialogs(this.dialogsHost(), options.answers)
    this.answers = new Answers(this.answerHost(), this.inputs, options.answers)
    const doorbell = this.doorbell
    if (doorbell)
      messaging.subscribe((change) => {
        if (change.kind === "terminal") doorbell.changed(change.terminalId)
      })
  }

  /**
   * Gives the terminal's agent a prompt as the person would paste and submit it (see
   * `Prompts`), once those before it in the terminal's input queue are done.
   */
  async prompt(terminalId: string, text: string): Promise<void> {
    return await this.prompts.prompt(terminalId, text)
  }

  /** Answers a request waiting on the person through its dialog (see `Terminals.answer`). */
  answer(terminalId: string, request: string, answer: RequestAnswer): Promise<void> {
    return this.answers.answer(terminalId, request, answer)
  }

  /** Presses Escape in the terminal's agent as the person would (see `Terminals.interrupt`). */
  async interrupt(terminalId: string): Promise<InterruptResult> {
    this.promptable(terminalId)
    return await this.inputs.run(terminalId, () => this.interrupts.interrupt(terminalId))
  }

  /** The terminal's screen or messages changed: the doorbell looks at it again. */
  doorbellChanged(terminalId: string): void {
    this.doorbell?.changed(terminalId)
  }

  /** The terminal's screen or requests changed: its dialogs are looked at again. */
  dialogsChanged(terminalId: string): void {
    this.dialogs.changed(terminalId)
  }

  /** Forgets what the doorbell and the dialogs kept of a terminal, as it exits or goes. */
  forget(terminalId: string): void {
    this.doorbell?.forget(terminalId)
    this.dialogs.forget(terminalId)
  }

  /** Stops the doorbell, as the runner shuts down. */
  close(): void {
    this.doorbell?.close()
  }

  /** Whether the activity says the agent in a running terminal works (`agentWorking`). */
  working(terminalId: string): boolean {
    const record = this.host.live(terminalId)
    return agentWorking(
      this.host.messaging(),
      terminalId,
      record?.binding ?? null,
      record?.activity ?? null,
    )
  }

  /** The harness of the agent bound to the terminal, or shown at its prompt, as its box reads. */
  boxOf(record: Record): BoxProfile | undefined {
    return profileOf(record.binding, () => this.host.messaging().shownAgent(record.summary.id))
  }

  /**
   * The record of a terminal whose agent takes the person's keys, or the error saying why
   * not: no agent bound, nor its own prompt shown before its first session binds, or one
   * that waits on the person's answer to a request, whose dialog would take them.
   */
  promptable(terminalId: string): Record {
    if (this.host.stopping()) throw new DomainError("CLOSING")
    const record = this.host.record(terminalId)
    this.host.running(record)
    if (!record.binding && this.host.messaging().shownAgent(terminalId) === undefined)
      throw new DomainError(
        "CONFLICT",
        "No agent is running in this terminal.",
        undefined,
        "no-agent",
      )
    if ((record.activity?.pending.length ?? 0) > 0)
      throw new DomainError(
        "CONFLICT",
        "The agent waits on the person's answer to a request.",
        undefined,
        "pending",
      )
    return record
  }

  /** The screen of a running terminal once it has drawn what its shell already sent. */
  async screenOf(terminalId: string): Promise<ScreenText | undefined> {
    const record = this.host.live(terminalId)
    if (!record) return undefined
    const child = record.terminal.pty
    const text = await record.terminal.readScreen()
    return record.terminal.pty === child && this.host.live(terminalId) ? text : undefined
  }

  /**
   * Holds the person's input to a running terminal for at most `budget.inputMs`, and the app's
   * resizes until the hold settles (see `InputQueueHost.hold`). The queue gives one piece of
   * work the terminal at a time, so none holds it in force: only the resizes of the one
   * before may be, which this hold takes over.
   */
  holdInput(terminalId: string, budget: HoldBudget): InputHold {
    const record = this.host.live(terminalId)
    if (!record) return noHold
    return record.terminal.hold(budget)
  }

  /**
   * Looks at the screen while delivery is Drafting only by doubt after a late hook: once
   * the agent's box reads empty on two reads running, nothing was left in it, and delivery
   * is Ready before its first turn or Settled after one completed. Gives up when doubt
   * ends or after `boxSettleMs`, leaving the draft; a later doubt has its own window.
   */
  settleBox(record: Record): void {
    const id = record.summary.id
    const messaging = this.host.messaging()
    const current = messaging.delivery(id)
    if (
      this.settling.has(id) ||
      current?.state !== "drafting" ||
      !current.box.doubted ||
      record.boxDoubtEpoch === current.epoch
    )
      return
    this.settling.add(id)
    void (async () => {
      let until = 0
      let epoch: number | undefined
      let seen = false
      try {
        for (;;) {
          const delivery = messaging.delivery(id)
          // The cases where `emptied` does nothing in the current epoch: keep the two in step,
          // or the `continue` below spins without waiting.
          if (!delivery?.box.doubted || delivery.state !== "drafting") return
          // A new doubt starts anew: its own window, its own two reads.
          if (delivery.epoch !== epoch) {
            epoch = delivery.epoch
            record.boxDoubtEpoch = epoch
            until = Date.now() + boxSettleMs
            seen = false
          }
          if (Date.now() >= until) return
          // The read counts from before it began: a key typed meanwhile is not forgotten.
          const readAt = Date.now()
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          const screen = await this.screenOf(id)
          const profile = this.host.live(id) && this.boxOf(record)
          if (!screen || !profile) return
          const box = profile.read(screen)
          const empty =
            box !== undefined && box.mode === "prompt" && isEmpty(box) && !profile.queued(screen)
          if (empty && seen) {
            messaging.emptied(id, delivery.epoch, readAt)
            // Stale if the epoch changed during the read: a later doubt is polled anew.
            continue
          }
          seen = empty
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          await sleep(100, undefined, { ref: false })
        }
      } finally {
        this.settling.delete(id)
      }
    })().catch(() => undefined)
  }

  /** Types into a running terminal as the person's keys would, through what watches them. */
  private typed(terminalId: string, data: string): boolean {
    const record = this.host.live(terminalId)
    if (!record) return false
    this.host.keyed(record, data)
    record.terminal.type(data)
    return true
  }

  /**
   * Presses an answer's keys into a running terminal, through what watches the person's
   * keys, which delivery takes as Novadeck's own while a request waits: no draft of theirs.
   */
  private pressed(terminalId: string, data: string): boolean {
    const record = this.host.live(terminalId)
    if (!record) return false
    this.host.messaging().pressing(terminalId, () => this.host.keyed(record, data))
    record.terminal.type(data)
    return true
  }

  /** What prompts ask of the terminals and messaging. */
  private promptHost(): ConstructorParameters<typeof Prompts>[0] {
    return {
      admit: (terminalId) => {
        const profile = this.boxOf(this.promptable(terminalId))
        // No harness to read its box, no prompt: nothing tells where the text would land.
        if (!profile)
          throw new DomainError(
            "CONFLICT",
            "No agent is running in this terminal.",
            undefined,
            "no-agent",
          )
        return profile
      },
      bound: (terminalId) => {
        const record = this.host.live(terminalId)
        return record === undefined || record.binding !== null
      },
      ringing: (terminalId) => this.host.messaging().ringing(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => this.typed(terminalId, data),
    }
  }

  private interruptHost(): ConstructorParameters<typeof Interrupts>[0] {
    return {
      admit: (terminalId) => void this.promptable(terminalId),
      working: (terminalId) => this.host.live(terminalId)?.activity?.state === "working",
      alive: (terminalId) => this.host.live(terminalId) !== undefined,
      profile: (terminalId) => {
        const record = this.host.live(terminalId)
        return record && this.boxOf(record)
      },
      prompt: (terminalId) => this.host.messaging().personPrompt(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => this.typed(terminalId, data),
      write: (terminalId, data) => {
        const record = this.host.live(terminalId)
        if (!record) return false
        record.terminal.type(data)
        return true
      },
    }
  }

  /** What the dialog adapters need of a pending request: what it asks, and where. */
  private factsOf(record: Record, request: Activity["pending"][number]): RequestFacts {
    return {
      kind: request.kind,
      tool: request.toolName,
      input: request.input,
      cwd: request.cwd ?? record.summary.cwd,
    }
  }

  /** The request of a terminal's bound agent that a ref names, with its facts. */
  private waiting(record: Record, ref: string) {
    const { binding, activity } = record
    if (!binding || !activity) return undefined
    const request = activity.pending.find((each) => requestRef(binding, each) === ref)
    return request && { binding, request }
  }

  /** What answering requests asks of the terminals and the dialogs read. */
  private answerHost(): ConstructorParameters<typeof Answers>[0] {
    return {
      request: (terminalId, ref) => {
        if (this.host.stopping()) throw new DomainError("CLOSING")
        const record = this.host.record(terminalId)
        this.host.running(record)
        const found = this.waiting(record, ref)
        if (!found) return undefined
        const { binding, request } = found
        return {
          actor: request.actor,
          facts: this.factsOf(record, request),
          adapter: harnesses[binding.agent].dialogs,
          others: (record.activity?.pending ?? [])
            .filter((each) => each !== request)
            .map((each) => ({
              ref: requestRef(binding, each),
              actor: each.actor,
              facts: this.factsOf(record, each),
              askedAt: each.askedAt,
            })),
        }
      },
      ringing: (terminalId) => this.host.messaging().ringing(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      press: (terminalId, data) => this.pressed(terminalId, data),
      prompt: (entry, terminalId, text) => this.prompts.promptIn(entry, terminalId, text),
      working: (terminalId) => this.host.held(terminalId)?.activity?.state === "working",
      turnStartedAt: (terminalId) => {
        const activity = this.host.held(terminalId)?.activity
        return activity?.state === "working" ? activity.turnAt : undefined
      },
      closed: (terminalId, ref) => this.dialogs.closed(terminalId, ref),
      shown: (terminalId, ref) => {
        const dialog = this.dialogs.shown(terminalId, ref)
        return dialog !== null && dialog.type !== "raw"
      },
      answered: (terminalId, ref) => this.dialogs.answered(terminalId).has(ref),
      raw: (terminalId, ref) => this.dialogs.shown(terminalId, ref)?.type === "raw",
      lock: (terminalId, ref, reason, rows) => {
        this.dialogs.lock(terminalId, ref, reason, rows)
      },
      done: (terminalId, ref) => {
        this.dialogs.done(terminalId, ref)
        // A request only the screen told has no hook to say it was answered.
        const record = this.host.held(terminalId)
        const found = record && this.waiting(record, ref)
        if (record && found?.request.screen) this.clearScreenRequest(record, found.request)
      },
      busy: (terminalId, on) => {
        if (on) this.dialogs.begin(terminalId)
        else this.dialogs.end(terminalId)
      },
    }
  }

  /** What the dialogs tracker asks of the terminals. */
  private dialogsHost(): ConstructorParameters<typeof Dialogs>[0] {
    return {
      pending: (terminalId) => {
        const record = this.host.live(terminalId)
        const { binding, activity } = record ?? {}
        if (!record || !binding || !activity) return undefined
        return {
          agent: binding.agent,
          requests: activity.pending.map((request) => ({
            ref: requestRef(binding, request),
            actor: request.actor,
            facts: this.factsOf(record, request),
            subject: request.subject,
            screen: request.screen === true,
            askedAt: request.askedAt,
          })),
        }
      },
      adapter: (agent) => harnesses[agent].dialogs,
      screen: (terminalId) => this.screenOf(terminalId),
      ask: (terminalId, request) => {
        const record = this.host.live(terminalId)
        const { binding } = record ?? {}
        if (!record || !binding) return
        const { agent, sessionId, instance } = binding
        const fact: ActivityEvent = {
          type: "attention-requested",
          agent,
          sessionId,
          instance,
          startedAt: Date.now(),
          // One per time it shows: the same while it does.
          requestId: `screen:${request.tool}:${randomUUID()}`,
          actor: null,
          toolName: request.tool,
          kind: request.kind,
          subject: request.subject,
          choices: [],
          input: request.input,
          screen: true,
        }
        if (this.host.applyFact(record, fact)) this.host.publishAgent(record, false)
      },
      clear: (terminalId, ref) => {
        const record = this.host.live(terminalId)
        const found = record && this.waiting(record, ref)
        if (record && found) this.clearScreenRequest(record, found.request)
      },
      changed: (terminalId) => {
        const record = this.host.held(terminalId)
        if (record) this.host.detailed(record)
      },
    }
  }

  /** A request only the screen told no longer waits: its screen is gone, or it was answered. */
  private clearScreenRequest(record: Record, request: Activity["pending"][number]): void {
    const { binding } = record
    if (!binding) return
    const { agent, sessionId, instance } = binding
    const fact: ActivityEvent = {
      type: "attention-resolved",
      agent,
      sessionId,
      instance,
      startedAt: Date.now(),
      requestId: request.requestId,
      actor: null,
      toolName: request.toolName,
      loose: false,
      outcome: "allowed",
    }
    if (this.host.applyFact(record, fact)) this.host.publishAgent(record, false)
  }

  /** What the doorbell asks of the terminals and messaging. */
  private ringHost(): ConstructorParameters<typeof Doorbell>[0] {
    return doorbellHost({
      live: (terminalId) => this.host.live(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      shownAgent: (terminalId) => this.host.messaging().shownAgent(terminalId),
      alive: (pid) => this.host.alive(pid),
      queued: (terminalId, work) => this.host.queued(terminalId, work),
      endExited: (record) => this.host.endExited(record),
      messaging: this.host.messaging(),
      working: (terminalId, activity) =>
        agentWorking(
          this.host.messaging(),
          terminalId,
          this.host.live(terminalId)?.binding ?? null,
          activity,
        ),
      stopping: () => this.host.stopping(),
    })
  }
}
