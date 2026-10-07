import { setTimeout as sleep } from "node:timers/promises"

import { hasControlCharacters, promptRefusal, type RequestAnswer } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import type { DialogAdapter, DialogRead, KeyStep, RequestFacts } from "../harnesses/dialogs.js"
import { identified, twin } from "./dialogs.js"
import { collapsible, type HoldBudget } from "./prompts.js"
import { bracketedPaste, findLine } from "./ring.js"
import type { ScreenText } from "./screen.js"

/** Another request waiting: its ref, who asks and what it asks. */
type Other = {
  readonly ref: string
  readonly actor: string | null
  readonly facts: RequestFacts
}

/** What answers need of the terminal manager and the dialogs tracker, by terminal. */
export type AnswerHost = {
  /**
   * The request a ref names, as the terminal's agent has it waiting; undefined when it
   * has none such. Throws `TERMINAL_NOT_FOUND`, `TERMINAL_EXITED` or `RUNTIME_CLOSING`
   * where the terminal can't take keys.
   */
  readonly request: (
    terminalId: string,
    ref: string,
  ) =>
    | {
        readonly facts: RequestFacts
        readonly actor: string | null
        readonly adapter: DialogAdapter | undefined
        /** The other requests waiting, by ref. */
        readonly others: readonly Other[]
      }
    | undefined
  /** The nonce of the doorbell ring under way there, if any. */
  readonly ringing: (terminalId: string) => string | undefined
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /**
   * Holds the person's input to the terminal for at most `budget.inputMs`, and its
   * window's resizes for at most `budget.sizeMs` or until `settle`, which releases the
   * input too (see `PromptHost.hold`).
   */
  readonly hold: (
    terminalId: string,
    budget: HoldBudget,
  ) => {
    readonly release: () => void
    readonly settle: () => void
    readonly holding: () => boolean
    /** Drops what the person typed while their input was held. */
    readonly discard: () => void
  }
  /**
   * Writes keys to the agent as the person's, through the bookkeeping their own keys get,
   * ahead of anything their held input waits to send; false once the terminal is gone.
   */
  readonly type: (terminalId: string, data: string) => boolean
  /** Whether nothing may be pressed for the request: its dialog turned raw, or it was answered. */
  readonly closed: (terminalId: string, ref: string) => boolean
  /** Whether the request was answered through `agents.answer` and waits still. */
  readonly answered: (terminalId: string, ref: string) => boolean
  /** Whether the request's dialog shows as raw now, unlocked: the screen reads as nothing. */
  readonly raw: (terminalId: string, ref: string) => boolean
  /** Whether the request had a dialog showing that the adapter read. */
  readonly shown: (terminalId: string, ref: string) => boolean
  /** The request's dialog turns raw for good, with the screen's text. */
  readonly lock: (
    terminalId: string,
    ref: string,
    reason: "unrecognized" | "failed",
    rows: readonly string[],
  ) => void
  /** The request was answered. */
  readonly done: (terminalId: string, ref: string) => void
  /**
   * Gives the agent `text` as its next prompt (see `Prompts`), as the person's words after
   * an option that only tells it to expect them: the plain call, which `Answers` retries
   * and times.
   */
  readonly prompt: (terminalId: string, text: string) => Promise<void>
  /** Whether its agent's turn runs now, per its hooks. */
  readonly working: (terminalId: string) => boolean
  /** An answer begins or ends there, so the dialogs tracker leaves its screens alone. */
  readonly busy: (terminalId: string, on: boolean) => void
}

export type AnswerOptions = {
  /** How often the screen is looked at while waiting, in milliseconds. */
  readonly pollMs?: number
  /** How long the dialog may take to show it was answered, in milliseconds. */
  readonly answeredMs?: number
  /** How long typed text may take to show in its field, in milliseconds. */
  readonly typedMs?: number
  /** How long a doorbell ring under way is waited for, in milliseconds. */
  readonly ringMs?: number
  /** How long after the last key the window's resizes stay held, in milliseconds. */
  readonly settleMs?: number
  /** The longest the person's keys are held for one answer, in milliseconds. */
  readonly holdMs?: number
  /** How long the screen is given to settle and the dialog to read before one is refused, in milliseconds. */
  readonly readMs?: number
  /** How far apart the two reads that say the screen settled are, in milliseconds. */
  readonly stillMs?: number
  /**
   * How long the agent is given to take the words that follow an answer as a prompt, from
   * when its screen settled, in milliseconds.
   */
  readonly followMs?: number
  /** How long the screen is given to settle after an answer, before the words, in milliseconds. */
  readonly calmMs?: number
}

/** A failure to answer, after some key was pressed or not. */
class Failed extends Error {
  constructor(
    message: string,
    readonly pressed: boolean,
  ) {
    super(message)
  }
}

/** Every piece of the person's own words in an answer. */
const wordsOf = (answer: RequestAnswer): string[] => {
  switch (answer.type) {
    case "choice":
    case "chat":
      return answer.text === undefined ? [] : [answer.text]
    case "questions":
      return answer.answers.flatMap(({ text }) => (text === undefined ? [] : [text]))
    case "form":
      return Object.values(answer.values).filter((value) => typeof value === "string")
  }
}

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").replaceAll("\t", " ")

/** Text as a TUI takes it in a paste: its line breaks are bare returns. */
const pasted = (text: string): string => text.replace(/\r\n?|\n/g, "\r")

/**
 * Answers agents' requests through their dialogs as the person would (see
 * docs/backend-api.md, `agents.answer`): it reads the dialog from the screen through the
 * harness's adapter once, holds the person's keys, presses what the adapter says for the
 * answer, waiting on its `until` steps between moves, and waits for the dialog to go
 * as the adapter predicts. Each press goes through the bookkeeping the person's own keys
 * get. It presses nothing without a dialog the adapter recognised as the request's, and
 * after one that failed or was unrecognised never presses for the request again. Where the
 * option chosen sends the person's words as the agent's next prompt, they follow once it
 * took. Answers
 * to one terminal go one at a time. Knows nothing of how any harness draws its screen.
 */
export class Answers {
  private readonly pollMs: number
  private readonly answeredMs: number
  private readonly typedMs: number
  private readonly ringMs: number
  private readonly settleMs: number
  private readonly holdMs: number
  private readonly readMs: number
  private readonly stillMs: number
  private readonly followMs: number
  private readonly calmMs: number
  /** The latest answer of each terminal that is not yet done. */
  private readonly tails = new Map<string, Promise<void>>()
  private readonly settles = new Map<string, () => void>()

  constructor(
    private readonly host: AnswerHost,
    options: AnswerOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 50
    this.answeredMs = options.answeredMs ?? 5_000
    this.typedMs = options.typedMs ?? 3_000
    this.ringMs = options.ringMs ?? 10_000
    this.settleMs = options.settleMs ?? 1_000
    this.holdMs = options.holdMs ?? 600_000
    this.readMs = options.readMs ?? 3_000
    this.stillMs = options.stillMs ?? 100
    this.followMs = options.followMs ?? 10_000
    this.calmMs = options.calmMs ?? 6_000
  }

  /**
   * Gives the request `ref` of the terminal's agent `answer`, once answers before it are
   * done. `NOT_FOUND` where the agent has no such request; `DIALOG_CHANGED` where the dialog the
   * answer names is not the one the screen reads now; `CONFLICT`, pressing nothing,
   * where its dialog isn't on screen, isn't recognised as the request's, can't take the
   * answer, was answered, or turned raw; `ANSWER_FAILED` where keys were pressed and the
   * dialog didn't go as expected; `WORDS_NOT_SENT` where the answer took but the words that
   * follow it as the agent's next prompt did not go. The dialog is read and fingerprinted
   * once the screen settled, and checked against the answer's `id` again on the screen
   * right before the first key, never after.
   */
  async answer(terminalId: string, ref: string, answer: RequestAnswer): Promise<void> {
    this.host.request(terminalId, ref)
    const previous = this.tails.get(terminalId) ?? Promise.resolve()
    const run = previous.then(() => this.send(terminalId, ref, answer))
    const tail = run.then(
      () => {},
      () => {},
    )
    this.tails.set(terminalId, tail)
    void tail.then(() => {
      if (this.tails.get(terminalId) === tail) this.tails.delete(terminalId)
    })
    return await run
  }

  private async send(terminalId: string, ref: string, answer: RequestAnswer): Promise<void> {
    const request = this.host.request(terminalId, ref)
    if (!request) throw new DomainError("NOT_FOUND", "The agent has no such request.")
    if (this.host.closed(terminalId, ref))
      throw new DomainError(
        "CONFLICT",
        "The request was answered, or its dialog can only be answered in the terminal.",
      )
    const { facts, adapter, others } = request
    const self = { facts, actor: request.actor }
    if (!adapter)
      throw new DomainError("CONFLICT", "The agent's dialogs can't be answered from outside.")
    // Its dialog reads as nothing now: nothing is pressed, and nothing is locked either.
    if (this.host.raw(terminalId, ref))
      throw new DomainError("CONFLICT", "The request's dialog isn't one the adapter reads.")
    // Keys the person's words can't carry: an escape sequence would be pressed, not typed.
    if (wordsOf(answer).some(hasControlCharacters))
      throw new DomainError("CONFLICT", "The answer's words hold control characters.")
    this.host.busy(terminalId, true)
    let rows: readonly string[] = []
    let hold: ReturnType<AnswerHost["hold"]> | undefined
    // The person's words, where the option they chose sends them as the next prompt.
    let words: string | undefined
    try {
      await this.ringDone(terminalId)
      // Their keys wait from before the dialog is read until the screen has settled after
      // the last key, and are dropped then, so none lands in the dialog or the next one.
      hold = await this.held(terminalId)
      const found = await this.readDialog(terminalId, ref, adapter, self, others)
      rows = found.rows
      const { read } = found
      if (identified(read.dialog)?.id !== answer.dialog)
        throw new DomainError("DIALOG_CHANGED", "The dialog on screen is not the one answered.")
      // Setting the questions aside to talk: only where the dialog offers it, and a field
      // takes words, which are the answer.
      if (answer.type === "chat") {
        const chat = read.dialog.type === "questions" ? read.dialog.chat : null
        if (chat === null)
          throw new DomainError("CONFLICT", "The dialog can't be set aside to talk it over.")
        if (chat === "field" && answer.text === undefined)
          throw new DomainError("CONFLICT", "Talking it over there takes words.")
        if (chat === "prompt") words = answer.text
      }
      const steps = read.keys(answer)
      if (!steps) throw new DomainError("CONFLICT", "The request's dialog can't take that answer.")
      // The hold must outlast every wait of the answer.
      const needs = steps.reduce(
        (total, step) => total + ("until" in step ? step.timeoutMs : this.typedMs),
        this.readMs + this.answeredMs + this.settleMs + 5_000,
      )
      if (needs > this.holdMs)
        throw new DomainError("CONFLICT", "The answer takes longer than the keys can be held.")
      if (answer.type === "choice" && read.dialog.type === "choices")
        words =
          read.dialog.options.find(({ id }) => id === answer.option)?.text === "prompt"
            ? answer.text
            : undefined
      // Words that follow as the agent's next prompt must be ones a prompt can carry, said
      // before any key is pressed, not after the dialog took its answer.
      const refusal = words === undefined ? undefined : promptRefusal(words)
      if (refusal) throw new DomainError("PROMPT_REFUSED", refusal)
      await this.run(terminalId, ref, steps, { adapter, facts, id: answer.dialog })
      const taken = await this.confirmed(terminalId, ref, read, adapter, self, others, found.rows)
      rows = taken.rows
      hold.discard()
      hold.release()
      this.settle(terminalId, hold.settle)
      // Through a twin's hook, or where its identical dialog shows again at once (the
      // harness folds twin calls into one request), it waits still, for the dialog that
      // shows next, which is as much its to answer.
      const next = adapter.read(taken.rows, facts)
      const again =
        next !== undefined && identified(next.dialog)?.id === identified(read.dialog)?.id
      if (!taken.viaTwin && !again) this.host.done(terminalId, ref)
    } catch (error) {
      // What the person typed meanwhile is dropped: it was meant for a dialog gone by now.
      if (error instanceof Failed && error.pressed) hold?.discard()
      hold?.release()
      // The window's resizes go on at once where no key was pressed, else once they have.
      if (error instanceof Failed && error.pressed && hold) this.settle(terminalId, hold.settle)
      else hold?.settle()
      if (!(error instanceof Failed)) throw error
      // Whatever the dialog was, nothing is pressed for the request again.
      this.host.lock(terminalId, ref, error.pressed ? "failed" : "unrecognized", rows)
      throw new DomainError(error.pressed ? "ANSWER_FAILED" : "CONFLICT", error.message)
    } finally {
      this.host.busy(terminalId, false)
    }
    if (words === undefined) return
    try {
      await this.follow(terminalId, words)
    } catch {
      // The dialog took its answer; only the words did not follow it.
      throw new DomainError(
        "WORDS_NOT_SENT",
        "The answer took, but the agent did not take the words that follow it.",
      )
    }
  }

  /**
   * Gives the agent the words once it takes a prompt: the answer that sends them is just
   * done, and the hook that ends the request, or the turn it aborted, may be a moment
   * behind. Retried only while the refusal is of the kind that clears by itself (a request
   * still pending, a doorbell ring, another hold on the agent's input), for `followMs`
   * from when the screen settled; a draft in the box, no box, a text too tall or a shell
   * mode never clear, and fail at once.
   */
  private async follow(terminalId: string, words: string): Promise<void> {
    await this.calm(terminalId)
    const until = Date.now() + this.followMs
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Tried in turn.
        return await this.host.prompt(terminalId, words)
      } catch (error) {
        const transient =
          error instanceof DomainError &&
          error.code === "CONFLICT" &&
          (error.reason === "pending" || error.reason === "ringing" || error.reason === "held")
        if (!transient || Date.now() >= until) throw error
        // eslint-disable-next-line no-await-in-loop -- As above.
        await sleep(this.pollMs * 2)
      }
    }
  }

  /**
   * Waits for the agent's screen to settle after an answer, before words follow it as a
   * prompt: an answer may let the turn go on (Claude Code's "Chat about this" has the model
   * reply), and a prompt pasted while its reply draws never sees a steady screen to check
   * its paste against. It settles once the screen held still for six reads' time
   * (`stillMs`, 0.6 s) with no turn running, or fifteen's (1.5 s) whatever the activity
   * says, and gives up after `calmMs`: a turn that goes on takes a prompt as the person's
   * typing would, which the prompt's own check allows for.
   */
  private async calm(terminalId: string): Promise<void> {
    const until = Date.now() + this.calmMs
    let last: string | undefined
    let since = Date.now()
    while (Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      const screen = await this.host.screen(terminalId)
      if (!screen) return
      const text = screen.rows.join("\n")
      if (text !== last) {
        last = text
        since = Date.now()
      }
      const still = Date.now() - since
      if (
        still >= 15 * this.stillMs ||
        (still >= 6 * this.stillMs && !this.host.working(terminalId))
      )
        return
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(this.pollMs * 2)
    }
  }

  /** Lets go of the window's resizes held after the last key, once they have lapsed. */
  private settle(terminalId: string, settle: () => void): void {
    this.settles.get(terminalId)?.()
    const timer = setTimeout(() => {
      this.settles.delete(terminalId)
      settle()
    }, this.settleMs)
    timer.unref()
    this.settles.set(terminalId, () => {
      clearTimeout(timer)
      settle()
    })
  }

  /** Waits for the ring under way, if any, to end; a ring that outlasts it is a conflict. */
  private async ringDone(terminalId: string): Promise<void> {
    const until = Date.now() + this.ringMs
    while (this.host.ringing(terminalId) !== undefined) {
      if (Date.now() >= until)
        throw new DomainError("CONFLICT", "A message's doorbell is ringing the agent.")
      // eslint-disable-next-line no-await-in-loop -- The ring is looked at in turn.
      await sleep(this.pollMs)
    }
  }

  /**
   * The person's input held for as long as the steps may take at most. A hold in force is
   * another's, waited out as a ring is.
   */
  private async held(terminalId: string): Promise<ReturnType<AnswerHost["hold"]>> {
    const until = Date.now() + this.ringMs
    for (;;) {
      // Past the input's own cap, as an answer's hold needs, the resizes stay held too.
      const hold = this.host.hold(terminalId, {
        inputMs: this.holdMs,
        sizeMs: this.holdMs + 10_000,
      })
      if (hold.holding()) return hold
      if (Date.now() >= until)
        throw new DomainError(
          "CONFLICT",
          "Another prompt or message holds the agent's input.",
          undefined,
          "held",
        )
      // eslint-disable-next-line no-await-in-loop -- The hold is tried in turn.
      await sleep(this.pollMs)
    }
  }

  /** Whether the screen held the same on two reads a moment apart; its rows if so. */
  private async still(terminalId: string): Promise<readonly string[] | undefined> {
    const first = await this.host.screen(terminalId)
    if (!first) throw new DomainError("TERMINAL_NOT_FOUND")
    await sleep(this.stillMs)
    const second = await this.host.screen(terminalId)
    if (!second) throw new DomainError("TERMINAL_NOT_FOUND")
    return first.rows.join("\n") === second.rows.join("\n") ? second.rows : undefined
  }

  /**
   * The dialog on a settled screen, read again for up to `readMs` before it is refused: a
   * redraw may be half done. It must read for this request alone. A dialog that showed and
   * never read turns raw; nothing is pressed either way.
   */
  private async readDialog(
    terminalId: string,
    ref: string,
    adapter: DialogAdapter,
    self: Pick<Other, "facts" | "actor">,
    others: readonly Other[],
  ): Promise<{ rows: readonly string[]; read: DialogRead }> {
    const until = Date.now() + this.readMs
    let rows: readonly string[] = []
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      const settled = await this.still(terminalId)
      if (settled) {
        rows = settled
        const read = adapter.read(rows, self.facts)
        if (read && identified(read.dialog)) {
          // Twins, asking the very same of the agent and reading the same dialog, make
          // the dialog the same to answer whichever request it is.
          const id = identified(read.dialog)?.id
          const shared = others.some((other) => {
            // An answered one is gone from the screen; one raw for good may not be.
            if (this.host.answered(terminalId, other.ref)) return false
            const theirs = adapter.read(rows, other.facts)
            return (
              theirs !== undefined && !(twin(self, other) && identified(theirs.dialog)?.id === id)
            )
          })
          if (shared)
            throw new DomainError(
              "CONFLICT",
              "The dialog on screen reads for more than one request.",
            )
          return { rows, read }
        }
      }
      if (Date.now() >= until) break
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(this.pollMs)
    }
    // A dialog that showed, or raw text, is no longer what it was: it stays raw.
    if (rows.length > 0 && this.host.shown(terminalId, ref))
      this.host.lock(terminalId, ref, "unrecognized", rows)
    throw new DomainError("CONFLICT", "The request's dialog isn't on the agent's screen.")
  }

  /**
   * Runs the steps. The dialog was read and matched once, before the first press; between
   * moves the adapter's own `until` steps wait for the screen to show what the next needs,
   * and the answer ends with its `answered` check. Before each press the request must
   * still wait on the person. Keys already pressed stay pressed when one fails.
   */
  private async run(
    terminalId: string,
    ref: string,
    steps: readonly KeyStep[],
    check: { readonly adapter: DialogAdapter; readonly facts: RequestFacts; readonly id: string },
  ): Promise<void> {
    let pressed = false
    for (const step of steps) {
      if ("until" in step) {
        // eslint-disable-next-line no-await-in-loop -- Each step needs the one before.
        await this.waitFor(terminalId, step, pressed)
        continue
      }
      // eslint-disable-next-line no-await-in-loop -- As above.
      const screen = await this.screen(terminalId, pressed)
      if (!this.host.request(terminalId, ref))
        throw new Failed("The request no longer waits on the person.", pressed)
      // The screen right before the first key reads as the dialog the answer names.
      if (!pressed) {
        const now = check.adapter.read(screen.rows, check.facts)
        if ((now && identified(now.dialog)?.id) !== check.id)
          throw new DomainError(
            "DIALOG_CHANGED",
            "The dialog changed before the keys were pressed.",
          )
      }
      const text = "press" in step ? step.press : this.typed(step.type, screen)
      if (!this.host.type(terminalId, text))
        throw new Failed("The terminal went away before the keys were pressed.", pressed)
      pressed = true
      if ("type" in step)
        // eslint-disable-next-line no-await-in-loop -- As above.
        await this.shownTyped(terminalId, step.type, screen)
    }
  }

  /** The text of a `type` step as the screen takes it: one bracketed paste, where it can. */
  private typed(text: string, screen: ScreenText): string {
    return screen.bracketedPaste ? bracketedPaste(pasted(text)) : oneLine(text)
  }

  private async screen(terminalId: string, pressed: boolean): Promise<ScreenText> {
    const screen = await this.host.screen(terminalId)
    if (!screen) throw new Failed("The terminal went away.", pressed)
    return screen
  }

  /** Waits for the screen to show what the next step needs. */
  private async waitFor(
    terminalId: string,
    step: Extract<KeyStep, { until: unknown }>,
    pressed: boolean,
  ): Promise<void> {
    const until = Date.now() + step.timeoutMs
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      const screen = await this.screen(terminalId, pressed)
      if (step.until(screen.rows)) return
      if (Date.now() >= until) throw new Failed(`The screen never showed ${step.why}.`, pressed)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(this.pollMs)
    }
  }

  /**
   * Waits for typed text to show, or its start, once more than before. Text a TUI may
   * collapse into a placeholder (several lines, or long) shows as the screen changing and
   * holding still on two reads instead.
   */
  private async shownTyped(terminalId: string, typed: string, before: ScreenText): Promise<void> {
    const shown = before.rows.join("\n")
    const start = typed.replace(/\s+/g, " ").trim().slice(0, 30)
    const had = findLine(before.rows, start).length
    const placeholder = collapsible(typed)
    const until = Date.now() + this.typedMs
    let last: string | undefined
    while (Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(this.pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const screen = await this.screen(terminalId, true)
      const now = screen.rows.join("\n")
      if (placeholder ? now !== shown && now === last : findLine(screen.rows, start).length > had)
        return
      last = now
    }
    throw new Failed("The typed text never showed in the dialog.", true)
  }

  /**
   * Waits for the dialog to be answered: its adapter says it went as the answer should have
   * it go, the request no longer waits (its hook said so), or the screen no longer reads as
   * its dialog and reads as another pending request's, on a screen that held still on two reads.
   */
  private async confirmed(
    terminalId: string,
    ref: string,
    read: DialogRead,
    adapter: DialogAdapter,
    self: Pick<Other, "facts" | "actor">,
    others: readonly Other[],
    before: readonly string[],
  ): Promise<{ readonly rows: readonly string[]; readonly viaTwin: boolean }> {
    const until = Date.now() + this.answeredMs
    let last: string | undefined
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      const screen = await this.screen(terminalId, true)
      const now = screen.rows.join("\n")
      const steady = now === last
      last = now
      if (steady) {
        // Or the dialog is no longer the request's, and another pending request's shows at
        // once, as queued permissions do.
        const next = () =>
          !adapter.read(screen.rows, self.facts) &&
          others.some(
            (other) =>
              !this.host.closed(terminalId, other.ref) && adapter.read(screen.rows, other.facts),
          )
        if (read.answered(screen.rows) || !this.host.request(terminalId, ref) || next())
          return { rows: screen.rows, viaTwin: false }
        // A twin's hook said it was answered: the dialog was approved all the same, and what
        // shows now may be the next of them, which is this request's to answer, not done.
        // The screen must have moved on from the dialog read before the keys, as a twin's
        // vanishing alone says nothing of what was pressed.
        if (
          now !== before.join("\n") &&
          others.some((other) => twin(self, other) && !this.host.request(terminalId, other.ref))
        )
          return { rows: screen.rows, viaTwin: true }
      }
      if (Date.now() >= until) throw new Failed("The dialog did not go as the answer should.", true)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(this.pollMs)
    }
  }
}
