import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import type { ActivityEvent } from "@novadeck/harness-core/events"
import {
  promptFailure,
  promptRefusal,
  type AgentBox,
  type InterruptResult,
  type RequestAnswer,
} from "@novadeck/protocol"
import { noHold } from "@novadeck/terminal/host"
import { Handovers, InputQueue } from "@novadeck/tui-input"
import type {
  BoxNote,
  HandoverNote,
  HoldBudget,
  InputHold,
  InterruptOptions,
  PromptOptions,
} from "@novadeck/tui-input"
import { isEmpty, newTurn, type BoxProfile, type TurnStatus } from "@novadeck/tui-input/box"

import { DomainError } from "../errors.js"
import { blocking, type Activity } from "../harnesses/activity.js"
import { versionOf } from "../harnesses/bindings.js"
import { requestRef } from "../harnesses/detail.js"
import { harnesses } from "../harnesses/registry.js"
import { logs } from "../log.js"
import { confirmMs, Doorbell, type DoorbellOptions } from "../messaging/doorbell.js"
import type { Messaging } from "../messaging/messaging.js"
import { Answers, type AnswersOptions } from "./answers.js"
import { bannerDrawn } from "./binding/banners.js"
import { boxView, BoxStates, shownBox } from "./box-state.js"
import { Dialogs, type DialogsOptions } from "./dialogs.js"
import { agentWorking, doorbellHost, profileOf } from "./doorbell-host.js"
import { GivenBack } from "./given-back.js"
import { splitImages } from "./image-marks.js"
import { imagePaste } from "./image-paste.js"
import { holdsRingLine, leftoverNonce } from "./leftover.js"
import { McpTools } from "./mcp-tools.js"
import { Interrupts, Prompts } from "./prompting.js"
import { freshRef, Receipts, type ReceiptsOptions } from "./receipts.js"
import type { Record } from "./record.js"
import { slicingOf } from "./slices.js"
import { holds, interruptionsOf } from "./transcripts.js"

const log = logs.for("chat")

/** What a prompt did about a box that held something, that says a harness may have changed. */
const fallbacks: ReadonlySet<BoxNote | HandoverNote> = new Set([
  "unsteady",
  "unreadable",
  "shape",
  "not-empty",
  "ringing",
  "ring-line",
  "too-tall",
  "no-paste",
  "clear-unconfirmed",
  "shell-unconfirmed",
  "cursor-unconfirmed",
  "command",
  "shell-kept",
  "draft-kept",
  "no-box",
  "not-shown",
  "images-kept",
])

/**
 * What the dialog adapters need of a pending request: what it asks, where (its hook's
 * directory, else the terminal's), what of it is answered, and, for one asked without
 * waiting, whether the agent's turn has ended since, by its activity's `state`.
 */
export const requestFacts = (
  request: Activity["pending"][number],
  cwd: string | null,
  state: Activity["state"] | undefined,
): RequestFacts => ({
  kind: request.kind,
  tool: request.toolName,
  input: request.input,
  cwd: request.cwd ?? cwd,
  ...(request.answered && { answered: request.answered }),
  ...(request.detached && state !== "working" && { turnEnded: true as const }),
})

/** The prompts' refusals that have the person clear the box, whose note must be there for it. */
const lookAtBox: ReadonlySet<string> = new Set(["draft", "shell", "command"])

/** What tells a terminal's bound session apart, for its prompts' receipts; null for none. */
const keyOf = (record: Record | undefined): string | null => {
  const binding = record?.bound?.binding
  return binding ? `${binding.agent}/${binding.sessionId}` : null
}

/** How long `settleBox` looks at a screen for an empty box, in milliseconds. */
const boxSettleMs = 5_000

/**
 * How long after a Stop the screen is looked at for a turn the program starts from its queue,
 * and how long none must show to say none runs. Its status row gave way to the next turn's
 * within 0.4 s, and went within 0.6 s where none ran, starved of CPU (e2e/probes/queued-busy):
 * a look that says neither by the end leaves the count as it was.
 */
const queueLookMs = 2_000
const queueGoneMs = 200

/** What `agents.prompt` gives: the text, and whether it is automatic, under which ref. */
export type PromptInput = {
  readonly terminalId: string
  readonly text: string
  readonly automatic?: true | undefined
  readonly along?: true | undefined
  readonly ref?: string | undefined
  /** Paths of image files the runner saved (checked by `Uploads.checkImages`), pasted ahead of the text. */
  readonly images?: readonly string[] | undefined
  /** The same files as the client named them, which Stop and takeBox answer; `images` where omitted. */
  readonly files?: readonly string[] | undefined
  /** Where each image goes in `text` (`agents.prompt`'s `at`); absent, they lead it. */
  readonly at?: readonly number[] | undefined
}

/**
 * What a prompt given resolves with: its receipt's ref, whether one follows, and the words it
 * took out of the agent's box to go, null for none.
 */
export type Prompted = {
  readonly ref: string
  readonly tracked: boolean
  readonly returned: string | null
}

/** What `takeBox` gives: the words, and the image files that led them in the box. */
export type TakenBox = {
  readonly returned: string | null
  readonly images?: string[]
  /** Where each of `images` stood in `returned`; absent where they led it, or none were. */
  readonly at?: number[]
}

export type TypingOptions = {
  readonly platform: NodeJS.Platform
  /** How the doorbell rings idle agents; it never rings with `false`, as in some tests. */
  readonly doorbell?: DoorbellOptions | false | undefined
  readonly prompts?: PromptOptions | undefined
  /** How interrupts wait; the queued turn's wait defaults from the platform. */
  readonly interrupts: InterruptOptions
  readonly answers?: (AnswersOptions & DialogsOptions) | undefined
  /** How prompts' receipts are followed; the slack defaults from the platform. */
  readonly receipts?: Partial<ReceiptsOptions> | undefined
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
  /** Whether a client reads the terminal's detail. */
  readonly detailWatched: (terminalId: string) => boolean
  /** Ends the binding of an agent known to have exited. */
  readonly endExited: (record: Record) => void
  /** Runs `work` in the terminal's turn of reports, after what is queued there. */
  readonly queued: (terminalId: string, work: () => void) => void
  /** Whether process `pid` still runs. */
  readonly alive: (pid: string) => boolean
  readonly messaging: () => Messaging
}

/** The end of a Stop that has not begun. */
const noStop = (_words: string | null): void => {}

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
  /** Whether each prompt given reached its agent's record, as `agents.detail` shows it. */
  readonly receipts: Receipts
  /** The messages a Stop took back, whose prompt hooks may still report. */
  readonly givenBack = new GivenBack()
  /** What each terminal's agent's box holds, for those a client reads. */
  readonly boxes: BoxStates
  /** Moves what the person is writing between an agent's box and a client's draft. */
  readonly handovers: Handovers
  /** When each terminal's last prompt had its Enter, whose text its box may still show. */
  private readonly entered = new Map<string, number>()
  /** The terminals whose box `settleBox` is looking at. */
  private readonly settling = new Set<string>()
  /**
   * The Stop each terminal was last looked at after (see `watchQueue`), once only: a second look
   * would take a queued turn already running for the ended one, and see none start.
   */
  private readonly queueLooks = new Map<string, number>()
  /** Which terminals' agents hold Novadeck's MCP tools, which the doorbell may wait for. */
  private readonly tools: McpTools

  constructor(
    options: TypingOptions,
    readonly host: TypingHost,
  ) {
    const messaging = host.messaging()
    this.inputs = new InputQueue({
      hold: (terminalId, budget) => this.holdInput(terminalId, budget),
    })
    this.tools = new McpTools(
      options.doorbell === false || options.doorbell?.toolsMs === undefined
        ? {}
        : { waitMs: options.doorbell.toolsMs },
    )
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
    this.receipts = new Receipts(this.receiptsHost(), {
      slackMs: confirmMs(options.platform),
      ...options.receipts,
    })
    this.boxes = new BoxStates(this.boxHost())
    this.handovers = new Handovers(this.handoverHost(), this.inputs)
    const doorbell = this.doorbell
    if (doorbell)
      messaging.subscribe((change) => {
        if (change.kind === "terminal") doorbell.changed(change.terminalId)
      })
  }

  /** `prompt` for the input of `agents.prompt`. */
  given(input: PromptInput): Promise<Prompted> {
    const { terminalId, text, automatic, ref, along, images, files, at } = input
    return this.prompt(terminalId, text, automatic, ref, along, images, files, at)
  }

  /**
   * Gives the terminal's agent a prompt as the person would paste and submit it (see
   * `Prompts`), once those before it in the terminal's input queue are done, followed under
   * `ref` until the agent's record has it (see `Receipts`). With `along`, which only a client
   * showing the box asks for, what the box holds doesn't stop it, where the screen shows that's
   * safe: it goes along, or out, the words handed back. Without it, it goes into an empty box.
   */
  async prompt(
    terminalId: string,
    text: string,
    automatic?: true | undefined,
    ref?: string | undefined,
    along?: true | undefined,
    images: readonly string[] = [],
    files: readonly string[] = images,
    at?: readonly number[],
  ): Promise<Prompted> {
    // Its ref is held at once, and it joins the input queue in this same tick, as it always
    // has, so nothing given after it goes before it. Its receipt is set up beside it: what
    // the record was is looked at long before any key of it lands.
    const claimed = ref ?? freshRef()
    this.receipts.claim(terminalId, claimed)
    this.givenBack.sent(terminalId, text)
    const following = this.receipts.expect(terminalId, text, claimed, files, at)
    // A fixed line from an Inbox button: the turn it starts withdraws no ask (see `automatic`).
    if (automatic) this.host.messaging().automatic(terminalId, text)
    let returned: string | null = null
    let went: string | undefined
    try {
      const given = await this.prompts.prompt(
        terminalId,
        text,
        along && !automatic && images.length === 0 ? "freed" : "alone",
        // Its receipt is set up by then, or as soon as it is: before its Enter, in either case.
        () =>
          void following.then(
            () => this.receipts.joined(terminalId, claimed),
            () => undefined,
          ),
        images.map(imagePaste),
        at,
        () =>
          void following.then(
            () => this.receipts.unplaced(terminalId, claimed),
            () => undefined,
          ),
      )
      returned = given?.returned ?? null
      went = given?.along
    } catch (error) {
      // Refused, failed or never given: no turn comes of it, so the mark would catch another.
      if (automatic) this.host.messaging().automaticFailed(terminalId, text)
      void following.then(
        () => this.receipts.failed(terminalId, claimed),
        () => undefined,
      )
      // Words it took out of the box go back with the failure: they wait on no record now.
      const taken = error instanceof DomainError && promptFailure.safeParse(error.data).data
      if (taken && taken.returned !== undefined)
        this.receipts.taken(terminalId, taken.returned, claimed)
      // A failure that says to look at the box comes after what the box holds.
      if (error instanceof DomainError && lookAtBox.has(error.reason ?? ""))
        await this.boxes.refresh(terminalId)
      throw error
    }
    const receipt = await following.catch(() => ({ ref: claimed, tracked: false }))
    // Words that came out are the person's draft again, and those that went along with it are
    // in the record as part of it: either way their prompts no longer wait.
    const out = returned ?? went
    if (out !== undefined) this.receipts.taken(terminalId, out, receipt.ref)
    this.entered.set(terminalId, Date.now())
    this.receipts.sent(terminalId, receipt.ref)
    return { ...receipt, returned }
  }

  /**
   * Takes what the agent's box holds out of it for the client's draft (see `Handovers.take`):
   * prompts of the person's back there no longer wait on the record.
   */
  async takeBox(terminalId: string): Promise<TakenBox> {
    this.promptable(terminalId)
    const boxed = await this.handovers.take(terminalId)
    if (boxed === undefined) return { returned: null }
    // The images in the box come out with the words: the files they were pasted from go back.
    const { words, marks, places } = splitImages(boxed)
    const given = this.receipts.boxGiven(terminalId, marks, words, false, places)
    this.receipts.taken(terminalId, words, undefined, marks, places)
    return {
      returned: (given.text ?? words) || null,
      ...(given.files.length > 0 && { images: [...given.files] }),
      ...(given.at && { at: given.at }),
    }
  }

  /** Writes keys as the person's, as a chat passes them on (see `agents.keys`). */
  keys(terminalId: string, keys: string): void {
    if (this.host.stopping()) throw new DomainError("CLOSING")
    const record = this.host.record(terminalId)
    this.host.running(record)
    const shown = this.host.messaging().shownAgent(terminalId)
    const slicing = slicingOf(record, this.dialogs.view(terminalId), shown)
    if (!slicing)
      throw new DomainError(
        "CONFLICT",
        "No agent is running in this terminal.",
        undefined,
        "no-agent",
      )
    // A request's dialog takes keys only where the chat can't answer it: it shows as rows.
    if (slicing.waiting && !slicing.unread)
      throw new DomainError(
        "CONFLICT",
        "A request waits on the person there.",
        undefined,
        "pending",
      )
    record.terminal.input(keys)
  }

  /** Puts a client's draft in the agent's box, with no Enter (see `Handovers.put`). */
  async putBox(terminalId: string, text: string): Promise<{ placed: boolean }> {
    this.promptable(terminalId)
    return { placed: await this.handovers.put(terminalId, text) }
  }

  /**
   * Empties the agent's box, as the person asked to, of the text `seen` they were shown (see
   * `Handovers.clear`). That's all that can be told of a tail, so one is left while a prompt may
   * have come back over it. Prompts whose words went no longer wait.
   */
  async clearBox(terminalId: string, seen: string): Promise<{ cleared: boolean }> {
    this.promptable(terminalId)
    const { cleared, went } = await this.handovers.clear(
      terminalId,
      (box, tail) => shownBox(box, seen) && !(tail && this.receipts.waiting(terminalId)),
    )
    if (went !== undefined) this.receipts.taken(terminalId, went)
    return { cleared }
  }

  /** Answers a request waiting on the person through its dialog (see `Terminals.answer`). */
  answer(terminalId: string, request: string, answer: RequestAnswer): Promise<void> {
    return this.answers.answer(terminalId, request, answer)
  }

  /** Presses Escape in the terminal's agent as the person would (see `Terminals.interrupt`). */
  async interrupt(terminalId: string): Promise<InterruptResult> {
    this.promptable(terminalId)
    let since = Date.now()
    let ended = noStop
    // The words as the agent's box held them, with any doorbell line a hook may still tell of.
    let boxed: string | null = null
    // The prompt that started the turn, as its hook told it, before the Stop changes that.
    const result = await this.inputs
      .run(terminalId, (entry) => {
        since = Date.now()
        ended = this.givenBack.begin(terminalId, since)
        return this.interrupts.interrupt(terminalId, entry, (words) => (boxed = words))
      })
      .catch(async (error: unknown) => {
        // Words it couldn't take out are back in the box, which the next prompt sees to.
        if (error instanceof DomainError && error.code === "BOX_NOT_CLEARED")
          await this.receipts.putBack(terminalId)
        throw error
      })
      .then(
        (one) => {
          ended(boxed)
          return one
        },
        (error: unknown) => {
          ended(null)
          throw error
        },
      )
    // The words handed back are the person's draft again: their prompts no longer wait.
    // The turn's own prompt put back and cleared gives back nothing, its images no more than
    // its words: the agent had both, and images alone in the box would ride the next message.
    const { marks, places } = result
    const given = result.restored
      ? { files: [] }
      : this.receipts.boxGiven(terminalId, marks, result.returned ?? "", true, places)
    if (result.returned !== null || marks > 0)
      this.receipts.withdraw(terminalId, result.returned ?? "", since, marks, places)
    return {
      returned: (given.text ?? result.returned) || null,
      ...(given.files.length > 0 && { images: [...given.files] }),
      ...(given.at && { at: given.at }),
    }
  }

  /** The terminal's screen or messages changed: the doorbell looks at it again. */
  doorbellChanged(terminalId: string): void {
    this.doorbell?.changed(terminalId)
  }

  /**
   * MCP session `session` in the terminal listed Novadeck's tools to its agent (`listed`),
   * or closed after that: a ring that waited for them may go.
   */
  mcpSession(terminalId: string, session: string, listed: boolean): void {
    if (this.tools.session(terminalId, session, listed)) this.doorbell?.changed(terminalId)
  }

  /** The terminal's screen or requests changed: its dialogs are looked at again, and a banner read. */
  dialogsChanged(terminalId: string): void {
    this.dialogs.changed(terminalId)
    // A starting agent's banner, drawn before it binds, names the version running.
    const record = this.host.live(terminalId)
    if (record) bannerDrawn(record)
    this.boxes.changed(terminalId)
  }

  /** The terminal's agent changed what it does, or its session: its receipts look again. */
  receiptsChanged(terminalId: string): void {
    this.receipts.changed(terminalId)
  }

  /** Forgets what the doorbell, the dialogs and the receipts kept of a terminal, as it exits or goes. */
  forget(terminalId: string): void {
    this.doorbell?.forget(terminalId)
    this.tools.forget(terminalId)
    this.dialogs.forget(terminalId)
    this.receipts.forget(terminalId)
    this.givenBack.forget(terminalId)
    this.boxes.forget(terminalId)
    this.entered.delete(terminalId)
    this.queueLooks.delete(terminalId)
  }

  /** Stops the doorbell and the receipts, as the runner shuts down. */
  close(): void {
    this.doorbell?.close()
    this.receipts.close()
    this.boxes.close()
  }

  /** The harness of the agent bound to the terminal, or shown at its prompt, as its box reads. */
  boxOf(record: Record): BoxProfile | undefined {
    return profileOf(record.bound?.binding ?? null, () =>
      this.host.messaging().shownAgent(record.summary.id),
    )
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
    if (!record.bound && this.host.messaging().shownAgent(terminalId) === undefined)
      throw new DomainError(
        "CONFLICT",
        "No agent is running in this terminal.",
        undefined,
        "no-agent",
      )
    if (blocking(record.bound?.activity.pending).length > 0)
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
   * After a Stop, looks at the screen for what runs now, where the program's queue starts its
   * turns with no hook (a profile with `status`): its status row giving way to a new turn's
   * says one runs from the queue, and none for `queueGoneMs` says none does. Told to messaging
   * (`queueSeen`); a look that says neither within `queueLookMs` tells it nothing.
   */
  watchQueue(record: Record): void {
    const id = record.summary.id
    const messaging = this.host.messaging()
    const stop = messaging.queueLook(id)
    const profile = this.boxOf(record)
    if (stop === undefined || !profile?.status || this.queueLooks.get(id) === stop) return
    const status = profile.status
    this.queueLooks.set(id, stop)
    void (async () => {
      const until = Date.now() + queueLookMs
      let before: TurnStatus | undefined
      let first = true
      let gone: number | undefined
      while (Date.now() < until && messaging.queueLook(id) === stop) {
        // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
        const screen = await this.screenOf(id)
        if (!screen || !this.host.live(id)) return
        const now = status(screen)
        // The ended turn's own row, as first seen, is what a new turn's is told from.
        if (first) before = now
        else if (newTurn(before, now)) return messaging.queueSeen(id, stop, true)
        if (now?.ending) before = now
        first = false
        gone = now === undefined ? (gone ?? Date.now()) : undefined
        if (gone !== undefined && Date.now() - gone >= queueGoneMs)
          return messaging.queueSeen(id, stop, false)
        // eslint-disable-next-line no-await-in-loop -- As above.
        await sleep(25)
      }
    })()
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

  /**
   * An answer's keys that didn't go as it should have may have landed in the agent's box,
   * as Antigravity's artifact review types into it: a possible draft, as the person's keys
   * would leave, until a submission or the screen says otherwise.
   */
  private astray(terminalId: string): void {
    const record = this.host.live(terminalId)
    if (!record) return
    const asked = blocking(record.bound?.activity.pending).length > 0
    this.host.messaging().keys(terminalId, ["content"], asked)
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
        return record === undefined || record.bound !== null
      },
      ringing: (terminalId) => this.host.messaging().ringing(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => this.typed(terminalId, data),
      write: (terminalId, data) => this.written(terminalId, data),
      known: (terminalId, text) => this.receipts.known(terminalId, text),
      ringLine: (_terminalId, text) => leftoverNonce(text) !== undefined,
      note: (terminalId, note) => this.noted(terminalId, note),
      refused: (terminalId, reason) => {
        const binding = this.host.live(terminalId)?.bound?.binding
        const version = binding ? versionOf(binding) : null
        const data = { reason, agent: binding?.agent ?? null, version }
        log.warn("chat.box", "A prompt was refused.", { data })
      },
    }
  }

  /**
   * Whether the images leading a box's text are all prompts' of the chat, whose files are
   * known and can go back: not those the person pasted in the terminal, which a clear would lose.
   */
  private ownImages(terminalId: string, text: string, queued: boolean): boolean {
    const { words, marks, places } = splitImages(text)
    return this.receipts.boxFiles(terminalId, marks, words, queued, places).length > 0
  }

  /** Writes keys to a running terminal as they are, with none of what watches the person's. */
  private written(terminalId: string, data: string): boolean {
    const record = this.host.live(terminalId)
    if (!record) return false
    record.terminal.type(data)
    return true
  }

  /** What handing words over asks of the terminals. */
  private handoverHost(): ConstructorParameters<typeof Handovers>[0] {
    return {
      admit: (terminalId) => {
        const profile = this.boxOf(this.promptable(terminalId))
        if (!profile)
          throw new DomainError(
            "CONFLICT",
            "No agent is running in this terminal.",
            undefined,
            "no-agent",
          )
        return profile
      },
      ringing: (terminalId) => this.host.messaging().ringing(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => this.typed(terminalId, data),
      write: (terminalId, data) => this.written(terminalId, data),
      known: (terminalId, text) => this.receipts.known(terminalId, text),
      ownImages: (terminalId, text) => this.ownImages(terminalId, text, false),
      ringLine: (_terminalId, text) => holdsRingLine(text),
      enteredAt: (terminalId) => this.entered.get(terminalId),
      refuse: (text) => promptRefusal(text, { shell: true }),
      note: (terminalId, note) => this.noted(terminalId, note),
    }
  }

  /** Logs what a prompt or a handover did about a box, with no words of it. */
  private noted(terminalId: string, note: BoxNote | HandoverNote): void {
    const binding = this.host.live(terminalId)?.bound?.binding
    const data = {
      note,
      agent: binding?.agent ?? null,
      version: binding ? versionOf(binding) : null,
    }
    if (fallbacks.has(note))
      log.warn("chat.box", "A prompt or handover left the agent's box undone, or was refused.", {
        data,
      })
    else
      log.info("chat.box", "A prompt or handover dealt with what the agent's box held.", { data })
  }

  /** Whether the agent's box holds text on its screen; undefined when the screen can't be read. */
  async boxHolds(terminalId: string): Promise<boolean | undefined> {
    const view = await this.boxHost().read(terminalId)
    return view === undefined ? undefined : view !== null
  }

  /** What following the agents' boxes asks of the terminals. */
  private boxHost(): ConstructorParameters<typeof BoxStates>[0] {
    return {
      watched: (terminalId) => this.host.detailWatched(terminalId),
      typing: (terminalId) =>
        this.inputs.busy(terminalId) || this.host.messaging().ringing(terminalId) !== undefined,
      read: async (terminalId): Promise<AgentBox | null | undefined> => {
        const screen = await this.screenOf(terminalId)
        const record = this.host.live(terminalId)
        const profile = record && this.boxOf(record)
        if (!screen || !profile) return undefined
        return boxView(
          profile,
          screen,
          (text) => this.receipts.known(terminalId, text) !== undefined,
          (text) => leftoverNonce(text) !== undefined,
        )
      },
      changed: (terminalId) => {
        const record = this.host.held(terminalId)
        if (record) this.host.detailed(record)
      },
    }
  }

  private interruptHost(): ConstructorParameters<typeof Interrupts>[0] {
    return {
      admit: (terminalId) => void this.promptable(terminalId),
      working: (terminalId) => this.host.live(terminalId)?.bound?.activity.state === "working",
      alive: (terminalId) => this.host.live(terminalId) !== undefined,
      profile: (terminalId) => {
        const record = this.host.live(terminalId)
        return record && this.boxOf(record)
      },
      prompt: (terminalId) => this.host.messaging().personPrompt(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => this.typed(terminalId, data),
      write: (terminalId, data) => this.written(terminalId, data),
      ownImages: (terminalId, text) => this.ownImages(terminalId, text, true),
    }
  }

  /** What the dialog adapters need of a pending request: what it asks, and where. */
  private factsOf(record: Record, request: Activity["pending"][number]): RequestFacts {
    return requestFacts(request, record.summary.cwd, record.bound?.activity.state)
  }

  /** The request of a terminal's bound agent that a ref names, with its facts. */
  private waiting(record: Record, ref: string) {
    const { bound } = record
    if (!bound) return undefined
    const { binding } = bound
    const request = bound.activity.pending.find((each) => requestRef(binding, each) === ref)
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
          others: (record.bound?.activity.pending ?? [])
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
      working: (terminalId) => this.host.held(terminalId)?.bound?.activity.state === "working",
      turnStartedAt: (terminalId) => {
        const activity = this.host.held(terminalId)?.bound?.activity
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
        if (reason === "failed") this.astray(terminalId)
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

  /** What the receipts ask of the terminals: the root's record, its turns, and its box. */
  private receiptsHost(): ConstructorParameters<typeof Receipts>[0] {
    return {
      source: async (terminalId) => {
        const record = this.host.live(terminalId)
        const binding = record?.bound?.binding
        const root = record?.transcript
        const source = binding && harnesses[binding.agent].transcripts
        if (!record || !binding || !root || !source) return undefined
        const path = await source.locate(root, binding.sessionId, null)
        // The same session: a status line telling its version meanwhile makes a binding of its own,
        // which the prompt would otherwise go unfollowed for.
        if (!path || !holds(record.bound?.binding, binding)) return undefined
        return {
          key: keyOf(record)!,
          agent: binding.agent,
          version: versionOf(record.bound!.binding),
          path,
          items: source.items,
          ...(source.step && { step: source.step }),
        }
      },
      bound: (terminalId) => keyOf(this.host.held(terminalId)),
      shown: (terminalId) => this.host.messaging().shownAgent(terminalId),
      interruptions: (terminalId) => {
        const record = this.host.held(terminalId)
        return record ? interruptionsOf(record, null)() : []
      },
      turns: (terminalId) => {
        const activity = this.host.held(terminalId)?.bound?.activity
        if (!activity) return { working: false, endedAt: null }
        const working = activity.state === "working"
        return {
          working,
          endedAt: working ? null : (activity.lastTurn?.at ?? activity.turnAt),
          startedAt: working ? activity.turnAt : null,
        }
      },
      box: async (terminalId) => {
        const screen = await this.screenOf(terminalId)
        const record = this.host.live(terminalId)
        const profile = record && this.boxOf(record)
        return screen && profile ? profile.read(screen)?.text : undefined
      },
      changed: (terminalId) => {
        const record = this.host.held(terminalId)
        if (record) this.host.detailed(record)
        // Whether the box's words are known may have changed with a receipt.
        this.boxes.changed(terminalId)
      },
    }
  }

  /** What the dialogs tracker asks of the terminals. */
  private dialogsHost(): ConstructorParameters<typeof Dialogs>[0] {
    return {
      pending: (terminalId) => {
        const record = this.host.live(terminalId)
        const bound = record?.bound
        if (!record || !bound) return undefined
        const { binding, activity } = bound
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
        const binding = record?.bound?.binding
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
    const binding = record.bound?.binding
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
      working: (terminalId, bound) => agentWorking(this.host.messaging(), terminalId, bound),
      stopping: () => this.host.stopping(),
      toolsWait: (terminalId) => this.tools.wait(terminalId),
    })
  }
}
