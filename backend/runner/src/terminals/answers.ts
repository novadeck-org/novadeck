import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"
import type {
  DialogAdapter,
  DialogRead,
  KeyStep,
  RequestFacts,
} from "@novadeck/harness-core/dialogs"
import { hasControlCharacters, promptRefusal, type RequestAnswer } from "@novadeck/protocol"
import {
  bracketedPaste,
  type InputEntry,
  type InputHold,
  type InputQueue,
} from "@novadeck/tui-input"

import { DomainError } from "../errors.js"
import { identified, twin } from "./dialogs.js"

/** Another request waiting: its ref, who asks and what it asks. */
type Other = {
  readonly ref: string
  readonly actor: string | null
  readonly facts: RequestFacts
  /** When its hook started, on the clock of `Date.now`. */
  readonly askedAt: number
}

/** What answers need of the terminal manager and the dialogs tracker, by terminal. */
export type AnswersHost = {
  /**
   * The request a ref names, as the terminal's agent has it waiting; undefined when it
   * has none such. Throws `TERMINAL_NOT_FOUND`, `TERMINAL_EXITED` or `CLOSING`
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
   * Presses the answer's keys in the request's dialog, ahead of anything the person's held
   * input waits to send, through the bookkeeping their own keys get, which takes them as
   * Novadeck's: they leave no draft of the person's. False once the terminal is gone.
   */
  readonly press: (terminalId: string, data: string) => boolean
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
   * Gives the agent `text` as its next prompt (see `Prompts`), within the answer's own
   * entry of the terminal's input queue: the words that follow an option which only tells
   * the agent to expect them. The plain call, which `Answers` retries and times.
   */
  readonly prompt: (entry: InputEntry, terminalId: string, text: string) => Promise<void>
  /** Whether its agent's turn runs now, per its hooks. */
  readonly working: (terminalId: string) => boolean
  /** When its agent's running turn began, on the runner's clock; undefined where none runs. */
  readonly turnStartedAt: (terminalId: string) => number | undefined
  /** An answer begins or ends there, so the dialogs tracker leaves its screens alone. */
  readonly busy: (terminalId: string, on: boolean) => void
  /** The requests that hold its agent (`blocking`), first met first: their refs and kinds. */
  readonly asking: (
    terminalId: string,
  ) => readonly { readonly ref: string; readonly kind: string | null }[]
  /** What an Escape in its agent's question dialog does (the harness's `questionEscape`). */
  readonly questionEscape: (terminalId: string) => "interrupts" | "skips" | undefined
}

export type AnswersOptions = {
  /** How often the screen is looked at while waiting, in milliseconds. */
  readonly pollMs?: number
  /** How long the dialog may take to show it was answered, in milliseconds. */
  readonly answeredMs?: number
  /** How long a key step is allowed in the hold's budget, in milliseconds. */
  readonly typedMs?: number
  /** How long a doorbell ring under way is waited for, in milliseconds. */
  readonly ringMs?: number
  /**
   * How long after the last key the window's resizes stay held, and how long a turn is
   * left to start before an answer presses its first key, in milliseconds.
   */
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

/**
 * Setting the question aside, as the person's Send or Stop does over it: Escape, or, where
 * Escape only skips a question and there are words, the words as its answer (see `setAside`).
 */
type Aside = {
  readonly type: "aside"
  readonly escape: "interrupts" | "skips"
  readonly text?: string
  /**
   * Throws, pressing nothing, where what holds the agent is no longer only the questions to
   * set aside: asked right before each key, as a request may come while the answer waits.
   */
  readonly guard: () => void
  /** Told once the words went into the dialog's field, whatever comes of them after. */
  readonly typed: () => void
}

/** What `setAside` did: nothing waited, the questions went, or the words went as the answer. */
export type SetAside = "none" | "dismissed" | "answered"

/** How many questions set aside one after another, at most, before one is refused. */
const asideRounds = 3

/** The refusal of a request that holds the agent, as a prompt's (`Typing.promptable`). */
export const waitsOnPerson = (message = "The agent waits on the person's answer to a request.") =>
  new DomainError("CONFLICT", message, undefined, "pending")

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
const wordsOf = (answer: RequestAnswer | Aside): string[] => {
  switch (answer.type) {
    case "aside":
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
 * took, as one entry of the terminal's input queue with the answer: nothing comes between
 * them. Knows nothing of how any harness draws its screen.
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

  constructor(
    private readonly host: AnswersHost,
    private readonly queue: InputQueue,
    options: AnswersOptions = {},
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
   * Gives the request `ref` of the terminal's agent `answer`, once those before it in the
   * terminal's input queue are done. `NOT_FOUND` where the agent has no such request; `DIALOG_CHANGED` where the dialog the
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
    await this.queue.run(terminalId, (entry) => this.send(entry, terminalId, ref, answer))
  }

  /**
   * Sets aside the questions the terminal's agent waits on, as the person's own Send or Stop
   * in a chat does, within `entry`, the turn of the input queue the prompt or Stop holds, so
   * nothing comes between. Where Escape ends the turn in its question dialog (the harness's
   * `questionEscape`, `interrupts`), Escape dismisses it, and this resolves once the request
   * no longer holds the agent, for the words to follow as a prompt; where Escape only skips
   * the question on screen (`skips`), `text` goes as its answer through the dialog's `chat`
   * (its Write-in, the rest skipped), and without words Escape skips each question until
   * the request is gone. Any request that is no question, or a dialog not read as one, is a
   * CONFLICT (`pending`), and images where the words go as an answer one of its own
   * (`question-words-only`), both pressing nothing. Keys go through `send`'s bookkeeping:
   * held input, the dialog read first, and a dialog that didn't go as it should locked for good.
   */
  async setAside(
    entry: InputEntry,
    terminalId: string,
    refs: readonly string[],
    text?: string,
    images = false,
  ): Promise<SetAside> {
    const guard = () => this.onlyAside(terminalId, refs)
    // Whether the words went into the dialog's field, as its answer.
    let wordsIn = false
    // Whether a question went by its keys, not by the person's in the terminal.
    let dismissed = false
    for (let round = 0; ; round += 1) {
      const asking = this.host.asking(terminalId)
      if (asking.length === 0) return dismissed ? "dismissed" : "none"
      const escape = this.host.questionEscape(terminalId)
      if (!escape || round >= asideRounds) throw waitsOnPerson()
      guard()
      const answers = escape === "skips" && text !== undefined
      if (answers && images)
        throw new DomainError(
          "CONFLICT",
          "The question takes the words as its answer, without images: answer it first, or send the words alone.",
          undefined,
          "question-words-only",
        )
      const { ref } = asking[0]!
      try {
        // eslint-disable-next-line no-await-in-loop -- One question after another.
        await this.send(entry, terminalId, ref, {
          type: "aside",
          escape,
          guard,
          typed: () => (wordsIn = true),
          ...(text !== undefined && { text }),
        })
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        if (!this.waits(terminalId, ref)) {
          // Its keys went and it is gone: as far as can be told, it went by them. Words typed
          // in as its answer are never given again as a prompt; words that never went in, as
          // where a key before them answered an option, follow as one.
          if (error.code === "ANSWER_FAILED") {
            if (answers && wordsIn) return "answered"
            dismissed = true
          }
          // Otherwise gone meanwhile, as one the person answered in the terminal as the entry
          // began: what holds the agent now is looked at again.
          continue
        }
        if (error.code !== "CONFLICT" || error.reason !== undefined) throw error
        // Its dialog went from the screen, and its hook may be a moment behind.
        // eslint-disable-next-line no-await-in-loop -- As above.
        if (await this.leaves(terminalId, ref, this.settleMs)) continue
        // Nothing pressed: the question waits, as for any prompt.
        throw new DomainError("CONFLICT", error.message, undefined, "pending", { cause: error })
      }
      if (answers) return "answered"
      dismissed = true
      // eslint-disable-next-line no-await-in-loop -- As above.
      if (!(await this.leaves(terminalId, ref, this.followMs)))
        throw waitsOnPerson("The question was set aside, but the agent still waits on it.")
    }
  }

  /**
   * Refuses, as a prompt is refused, where anything holds the agent but the questions `refs`
   * names: another request, or one that is no question.
   */
  private onlyAside(terminalId: string, refs: readonly string[]): void {
    const others = this.host
      .asking(terminalId)
      .some(({ ref, kind }) => kind !== "question" || !refs.includes(ref))
    if (others) throw waitsOnPerson()
  }

  /** Whether the request still holds the agent. */
  private waits(terminalId: string, ref: string): boolean {
    return this.host.asking(terminalId).some((each) => each.ref === ref)
  }

  /**
   * Waits up to `ms` for a request set aside to no longer hold the agent: its dialog went from
   * the screen, and its hook, which says so, may be a moment behind. Whether it went.
   */
  private async leaves(terminalId: string, ref: string, ms: number): Promise<boolean> {
    const until = Date.now() + ms
    while (this.waits(terminalId, ref)) {
      if (Date.now() >= until) return false
      // eslint-disable-next-line no-await-in-loop -- Looked at in turn.
      await sleep(this.pollMs)
    }
    return true
  }

  private async send(
    entry: InputEntry,
    terminalId: string,
    ref: string,
    answer: RequestAnswer | Aside,
  ): Promise<void> {
    // Keys the person's words can't carry: an escape sequence would be pressed, not typed.
    if (wordsOf(answer).some(hasControlCharacters))
      throw new DomainError("CONFLICT", "The answer's words hold control characters.")
    this.host.busy(terminalId, true)
    let rows: readonly string[] = []
    let hold: InputHold | undefined
    // The person's words, where the option they chose sends them as the next prompt.
    let words: string | undefined
    // Whether the dialog takes the whole answer as the agent's next prompt, pressing nothing.
    let byPrompt = false
    try {
      await this.ringDone(terminalId)
      await this.turnSettled(terminalId)
      // The request is read after the waits: a twin may register during them, and the
      // dialog's reading and its confirmation must see it.
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
      // Their keys wait from before the dialog is read until the screen has settled after
      // the last key, and are dropped then, so none lands in the dialog or the next one.
      hold = entry.hold({
        // Past the input's own cap, as an answer's hold needs, the resizes stay held too.
        inputMs: this.holdMs,
        sizeMs: this.holdMs + 10_000,
        deferred: true,
      })
      if (!hold.holding()) throw new DomainError("TERMINAL_NOT_FOUND")
      // A dialog set aside that doesn't read is left as it is, for the person to answer.
      const found = await this.readDialog(terminalId, ref, adapter, self, answer.type !== "aside")
      rows = found.rows
      const { read } = found
      // The answer given: one set aside with words through its chat, or none for Escape.
      let given: RequestAnswer | undefined
      if (answer.type === "aside") {
        if (read.dialog.type !== "questions")
          throw waitsOnPerson("The request's dialog is no question to set aside.")
        given =
          answer.escape === "skips" && answer.text !== undefined
            ? { type: "chat", dialog: identified(read.dialog)!.id, text: answer.text }
            : undefined
      } else if (identified(read.dialog)?.id !== answer.dialog)
        throw new DomainError("DIALOG_CHANGED", "The dialog on screen is not the one answered.")
      else given = answer
      if (given === undefined) {
        // Escape where it ends the turn; each where it skips a question, a Write-in opened
        // aside (its Escape goes back) one more.
        const most =
          answer.type === "aside" && answer.escape === "skips" && read.dialog.type === "questions"
            ? read.dialog.questions.length + 1
            : 1
        const guard = answer.type === "aside" ? answer.guard : () => undefined
        rows = await this.dismiss(terminalId, ref, adapter, most, guard)
        hold.discard()
        hold.release()
        this.settleLater(hold)
        this.host.done(terminalId, ref)
      } else if (read.prompt) {
        // A dialog answered as the agent's next prompt: nothing is pressed, and the prompt
        // goes as the person's would, once their keys are let go.
        // Only once no turn runs, as its hooks say, whatever the screen read as: a prompt
        // typed into a running turn waits for its end, a different answer from its dialog's.
        if (this.host.working(terminalId))
          throw new DomainError("CONFLICT", "The agent's turn runs: its dialog takes keys.")
        words = read.prompt(given)
        if (words === undefined)
          throw new DomainError("CONFLICT", "The request's dialog can't take that answer.")
        const refusal = promptRefusal(words)
        if (refusal) throw new DomainError("PROMPT_REFUSED", refusal)
        byPrompt = true
        hold.release()
        hold.settle()
      } else {
        // Setting the questions aside to talk: only where the dialog offers it, and a field
        // takes words, which are the answer.
        if (given.type === "chat") {
          const chat = read.dialog.type === "questions" ? read.dialog.chat : null
          if (chat === null)
            throw new DomainError("CONFLICT", "The dialog can't be set aside to talk it over.")
          if (chat === "field" && given.text === undefined)
            throw new DomainError("CONFLICT", "Talking it over there takes words.")
          if (chat === "prompt") words = given.text
        }
        const steps = read.keys(given)
        if (!steps)
          throw new DomainError("CONFLICT", "The request's dialog can't take that answer.")
        // The hold must outlast every wait of the answer.
        const needs = steps.reduce(
          (total, step) => total + ("until" in step ? step.timeoutMs : this.typedMs),
          this.readMs + this.answeredMs + this.settleMs + 5_000,
        )
        if (needs > this.holdMs)
          throw new DomainError("CONFLICT", "The answer takes longer than the keys can be held.")
        if (given.type === "choice" && read.dialog.type === "choices") {
          const { option } = given
          words =
            read.dialog.options.find(({ id }) => id === option)?.text === "prompt"
              ? given.text
              : undefined
        }
        // Words that follow as the agent's next prompt must be ones a prompt can carry, said
        // before any key is pressed, not after the dialog took its answer.
        const refusal = words === undefined ? undefined : promptRefusal(words)
        if (refusal) throw new DomainError("PROMPT_REFUSED", refusal)
        const pressedAt = await this.run(terminalId, ref, steps, {
          adapter,
          id: given.dialog,
          ...(answer.type === "aside" && { guard: answer.guard, typed: answer.typed }),
        })
        const taken = await this.confirmed(
          terminalId,
          ref,
          read,
          adapter,
          self,
          others,
          found.rows,
          pressedAt,
        )
        rows = taken.rows
        hold.discard()
        hold.release()
        this.settleLater(hold)
        // Through a twin's hook, or where its identical dialog shows again at once (the
        // harness folds twin calls into one request), it waits still, for the dialog that
        // shows next, which is as much its to answer.
        const next = adapter.read(taken.rows, facts)
        const again =
          next !== undefined && identified(next.dialog)?.id === identified(read.dialog)?.id
        if (!taken.viaTwin && !again) this.host.done(terminalId, ref)
      }
    } catch (error) {
      // What the person typed meanwhile is dropped: it was meant for a dialog gone by now.
      if (error instanceof Failed && error.pressed) hold?.discard()
      hold?.release()
      // The window's resizes go on at once where no key was pressed, else once they have.
      if (error instanceof Failed && error.pressed && hold) this.settleLater(hold)
      else hold?.settle()
      if (!(error instanceof Failed)) throw error
      // Whatever the dialog was, nothing is pressed for the request again.
      this.host.lock(terminalId, ref, error.pressed ? "failed" : "unrecognized", rows)
      throw new DomainError(error.pressed ? "ANSWER_FAILED" : "CONFLICT", error.message)
    } finally {
      this.host.busy(terminalId, false)
    }
    if (words === undefined) return
    if (byPrompt) {
      // Nothing took yet: whatever kept the prompt out is the answer's failure as it is.
      await this.follow(entry, terminalId, words)
      this.host.done(terminalId, ref)
      return
    }
    try {
      await this.follow(entry, terminalId, words)
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
   * behind. Retried only while a request still pending refuses it, for `followMs` from
   * when the screen settled; a draft in the box, no box, a text too tall or a shell mode
   * never clear, and fail at once.
   */
  private async follow(entry: InputEntry, terminalId: string, words: string): Promise<void> {
    await this.calm(terminalId)
    const until = Date.now() + this.followMs
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Tried in turn.
        return await this.host.prompt(entry, terminalId, words)
      } catch (error) {
        const transient =
          error instanceof DomainError && error.code === "CONFLICT" && error.reason === "pending"
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

  /**
   * Lets go of the window's resizes held after the last key, once they have lapsed: the
   * next entry of the terminal takes the hold over with them before that.
   */
  private settleLater(hold: InputHold): void {
    hold.settleAfter(this.settleMs)
  }

  /**
   * Waits for the turn that put the dialog up to have run for `settleMs`: a dialog drawn
   * as the turn starts is still in flux (the agent registers its parallel calls, and
   * identical ones fold into one request), and a key pressed then may be taken without the
   * screen or the hooks ever showing it. An answer after the prompt that began the turn
   * used to wait for that prompt's lingering resize hold, which lapsed on this time; the
   * queue hands the hold over at once, so the wait is made here. The turn's later
   * dialogs, and answers after answers, wait for nothing.
   */
  private async turnSettled(terminalId: string): Promise<void> {
    const began = this.host.turnStartedAt(terminalId)
    if (began === undefined) return
    // Bounded by the settle time: a clock that stepped must not hold an answer longer.
    const wait = Math.min(began + this.settleMs - Date.now(), this.settleMs)
    if (wait > 0) await sleep(wait)
  }

  /** Waits for the ring under way, if any, to end; a ring that outlasts it is a conflict. */
  private async ringDone(terminalId: string): Promise<void> {
    const until = Date.now() + this.ringMs
    while (this.host.ringing(terminalId) !== undefined) {
      if (Date.now() >= until)
        throw new DomainError(
          "CONFLICT",
          "A message's doorbell is ringing the agent.",
          undefined,
          "ringing",
        )
      // eslint-disable-next-line no-await-in-loop -- The ring is looked at in turn.
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
   * never read turns raw where it `locks`; nothing is pressed either way.
   */
  private async readDialog(
    terminalId: string,
    ref: string,
    adapter: DialogAdapter,
    self: Pick<Other, "facts" | "actor">,
    locks: boolean,
  ): Promise<{ rows: readonly string[]; read: DialogRead }> {
    const until = Date.now() + this.readMs
    let rows: readonly string[] = []
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      const settled = await this.still(terminalId)
      if (settled) {
        rows = settled
        // The requests' facts as they are now: a turn may end while the screen settles, and
        // the request may go, answered in the terminal.
        const current = this.host.request(terminalId, ref)
        if (!current) throw new DomainError("NOT_FOUND", "The agent has no such request.")
        const { facts, others: peers } = current
        const read = adapter.read(rows, facts)
        if (read && identified(read.dialog)) {
          // Twins, asking the very same of the agent and reading the same dialog, make
          // the dialog the same to answer whichever request it is.
          const id = identified(read.dialog)?.id
          const shared = peers.some((other) => {
            // An answered one is gone from the screen; one raw for good may not be.
            if (this.host.answered(terminalId, other.ref)) return false
            const theirs = adapter.read(rows, other.facts)
            return (
              theirs !== undefined &&
              // Dialogs answered as prompts never clash: each prompt names its own.
              !(read.prompt && theirs.prompt) &&
              !(twin({ ...self, facts }, other) && identified(theirs.dialog)?.id === id)
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
    if (locks && rows.length > 0 && this.host.shown(terminalId, ref))
      this.host.lock(terminalId, ref, "unrecognized", rows)
    throw new DomainError("CONFLICT", "The request's dialog isn't on the agent's screen.")
  }

  /**
   * Runs the steps. The dialog was read and matched once, before the first press; between
   * moves the adapter's own `until` steps wait for the screen to show what the next needs,
   * one after each `type` step among them, and the answer ends with its `answered` check. Before each press the request must
   * still wait on the person. Keys already pressed stay pressed when one fails.
   */
  private async run(
    terminalId: string,
    ref: string,
    steps: readonly KeyStep[],
    check: {
      readonly adapter: DialogAdapter
      readonly id: string
      /** Throws where the keys must not go now, asked before the first. */
      readonly guard?: () => void
      /** Told once a `type` step's words were pressed. */
      readonly typed?: () => void
    },
  ): Promise<number> {
    // Words typed into a field are checked by the adapter's own `until` right after, which
    // knows where its field shows them; an answer that would type unchecked presses nothing.
    if (steps.some((step, at) => "type" in step && !(steps[at + 1] && "until" in steps[at + 1]!)))
      throw new Error("The adapter types words without a check that they showed.")
    let pressed = false
    // When the first key went, on the clock of `Date.now`.
    let pressedAt = Date.now()
    for (const step of steps) {
      if ("until" in step) {
        // eslint-disable-next-line no-await-in-loop -- Each step needs the one before.
        await this.waitFor(terminalId, step, pressed)
        continue
      }
      // eslint-disable-next-line no-await-in-loop -- As above.
      const screen = await this.screen(terminalId, pressed)
      const current = this.host.request(terminalId, ref)
      if (!current) throw new Failed("The request no longer waits on the person.", pressed)
      // The screen right before the first key reads as the dialog the answer names, by the
      // request's facts as they are now: its turn may have ended since the dialog was read.
      if (!pressed) {
        const now = check.adapter.read(screen.rows, current.facts)
        if ((now && identified(now.dialog)?.id) !== check.id)
          throw new DomainError(
            "DIALOG_CHANGED",
            "The dialog changed before the keys were pressed.",
          )
        check.guard?.()
      }
      const text = "press" in step ? step.press : this.typed(step.type, screen)
      if (!pressed) pressedAt = Date.now()
      if (!this.host.press(terminalId, text))
        throw new Failed("The terminal went away before the keys were pressed.", pressed)
      pressed = true
      if ("type" in step) check.typed?.()
    }
    return pressedAt
  }

  /**
   * Presses Escape in the request's dialog, at most `most` times, each once the screen
   * settled after the one before, until the request is gone or its dialog no longer shows:
   * one Escape where it ends the turn, one a question where it skips the question on screen.
   * The screen must read as the request's dialog before each. Gives the screen's rows at the end.
   */
  private async dismiss(
    terminalId: string,
    ref: string,
    adapter: DialogAdapter,
    most: number,
    guard: () => void,
  ): Promise<readonly string[]> {
    let pressed = 0
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Each press waits for the one before.
      const screen = await this.screen(terminalId, pressed > 0)
      const current = this.host.request(terminalId, ref)
      if (!current) return screen.rows
      if (!adapter.read(screen.rows, current.facts)) {
        if (pressed === 0)
          throw new DomainError("CONFLICT", "The request's dialog isn't on the agent's screen.")
        return screen.rows
      }
      if (pressed >= most) throw new Failed("The question did not go as Escape should.", true)
      // A request asked meanwhile would take the Escape, as an approval's denial.
      guard()
      if (!this.host.press(terminalId, "\x1b"))
        throw new Failed("The terminal went away before the keys were pressed.", pressed > 0)
      pressed += 1
      // eslint-disable-next-line no-await-in-loop -- As above.
      await this.moved(terminalId, ref, screen.rows)
    }
  }

  /**
   * Waits after a key for the request to go, or the screen to settle other than it was
   * (`before`), on two reads running, for `answeredMs`.
   */
  private async moved(terminalId: string, ref: string, before: readonly string[]): Promise<void> {
    const until = Date.now() + this.answeredMs
    const was = before.join("\n")
    let last: string | undefined
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      const screen = await this.screen(terminalId, true)
      if (!this.host.request(terminalId, ref)) return
      const now = screen.rows.join("\n")
      if (now === last && now !== was) return
      last = now
      if (Date.now() >= until) throw new Failed("The screen did not move after Escape.", true)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(this.pollMs)
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
    pressedAt: number,
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
        // Answered as its adapter reads it, before anything asks the host: an answer
        // confirmed must not turn into the terminal's exit seen in the same poll.
        if (read.answered(screen.rows)) return { rows: screen.rows, viaTwin: false }
        // Or the dialog is no longer the request's, and another pending request's shows at
        // once, as queued permissions do. The requests are read now, not as they were when
        // the answer began: the next dialog's hook comes with its dialog (Codex's patch
        // approvals, one after another), so its request may not have existed when the keys
        // were pressed. A request that came into being only after the keys counts when it
        // was asked since the first of them, never one that came by for its own reasons.
        const current = this.host.request(terminalId, ref)
        if (!current) return { rows: screen.rows, viaTwin: false }
        const started = new Set(others.map(({ ref: each }) => each))
        const next = () =>
          !adapter.read(screen.rows, self.facts) &&
          current.others.some(
            (other) =>
              (started.has(other.ref) || other.askedAt >= pressedAt) &&
              !this.host.closed(terminalId, other.ref) &&
              adapter.read(screen.rows, other.facts),
          )
        if (next()) return { rows: screen.rows, viaTwin: false }
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
