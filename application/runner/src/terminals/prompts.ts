import { setTimeout as sleep } from "node:timers/promises"

import { normalisedText, promptRefusal, shellCommand } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { isEmpty, sameText, wrappedRows, type BoxProfile } from "../harnesses/box.js"
import { bracketedPaste } from "./ring.js"
import type { ScreenText } from "./screen.js"

/** What prompts need of the terminal manager and messaging, by terminal. */
export type PromptHost = {
  /**
   * Throws what refuses a prompt now: `TERMINAL_NOT_FOUND` or `TERMINAL_EXITED`, and
   * `CONFLICT` where no agent is there to take it (none bound, nor its own empty prompt
   * shown before its first session binds), or one waits on the person's answer, whose
   * dialog would take the text. Returns how the input box of the agent admitted reads off
   * the screen, which the prompt keeps for all it does: an agent that has gone by then
   * leaves a screen that box is not found on.
   */
  readonly admit: (terminalId: string) => BoxProfile
  /** The nonce of the doorbell ring under way there, if any. */
  readonly ringing: (terminalId: string) => string | undefined
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /**
   * Holds the person's input to the terminal for at most `inputMs`, and its window's
   * resizes for at most `sizeMs` or until `settle`, which releases the input too.
   * `holding` says the input is still held.
   */
  readonly hold: (
    terminalId: string,
    budget: HoldBudget,
  ) => {
    readonly release: () => void
    readonly settle: () => void
    readonly holding: () => boolean
  }
  /**
   * Writes keys to the agent as the person's, through the bookkeeping their own keys get,
   * ahead of anything their held input waits to send; false once the terminal is gone.
   */
  readonly type: (terminalId: string, data: string) => boolean
}

/** How long a hold's safety caps let it last, in milliseconds. */
export type HoldBudget = { readonly inputMs: number; readonly sizeMs: number }

export type PromptOptions = {
  /** How often the screen is looked at after the paste, in milliseconds. */
  readonly pollMs?: number
  /** How long the paste may take to show, in milliseconds. */
  readonly pasteMs?: number
  /** How long a doorbell ring under way is waited for, in milliseconds. */
  readonly ringMs?: number
  /** How long after its Enter the window's resizes stay held, in milliseconds. */
  readonly settleMs?: number
  /** How long a box holding text is waited on to read empty before the prompt is refused. */
  readonly emptyMs?: number
}

/**
 * Whether a TUI may show a paste as a placeholder (Claude Code's "[Pasted text #1 +4
 * lines]") rather than its text: more than one line, or long.
 */
export const collapsible = (text: string): boolean => /[\r\n]/.test(text) || text.length > 200

/** Rows added to the estimate of a text's height, as harnesses' wrapping may differ a little. */
const wrapMargin = 1

/** A prompt's lines as a terminal takes them in a paste: its line breaks are bare returns. */
const inPaste = (text: string): string => text.replace(/\r\n?|\n/g, "\r")

/**
 * Gives agents prompts as the person would (see docs/backend-api.md, `agents.prompt`): the
 * text as one bracketed paste with the person's keys held, then Enter once the box shows
 * exactly that text, or its placeholder for it, on two reads running, both through the
 * same bookkeeping the person's keys get. The harness's adapter reads the box (see
 * `harnesses/box.ts`): the paste goes in only where it is empty, so it never merges into
 * a draft, and Enter only where it holds nothing else. It never presses Enter after a
 * failed check: the text stays as a draft. Prompts to one terminal go one at a time, and
 * wait for a doorbell ring under way, so the two never share a box. A shell command (`!`
 * and a command) goes the way a person types it, which every harness takes: the `!` as a
 * key, then, once the box reads empty in its shell mode, the command as the paste, and
 * Enter once the box holds exactly it. A message never goes into a box in its shell mode,
 * where Enter would run it. It fails closed: a screen the box is not found on, whatever
 * the reason, writes nothing.
 */
export class Prompts {
  private readonly pollMs: number
  private readonly pasteMs: number
  private readonly ringMs: number
  private readonly settleMs: number
  private readonly emptyMs: number
  private readonly budget: HoldBudget
  /** The latest prompt of each terminal that is not yet done. */
  private readonly tails = new Map<string, Promise<void>>()
  /** Lets go of the resizes each terminal's latest prompt holds, until they lapse. */
  private readonly settles = new Map<string, () => void>()

  constructor(
    private readonly host: PromptHost,
    options: PromptOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 50
    this.pasteMs = options.pasteMs ?? 5_000
    this.ringMs = options.ringMs ?? 10_000
    this.settleMs = options.settleMs ?? 1_000
    this.emptyMs = options.emptyMs ?? 3_000
    // The held phase is the wait for the box to read empty, for a shell command's `!` to
    // switch it, and for the paste to show, with a margin; the window's resizes stay held a
    // while longer, past the Enter.
    const inputMs = this.emptyMs + 2 * this.pasteMs + 2_000
    this.budget = { inputMs, sizeMs: inputMs + this.settleMs }
  }

  /**
   * Gives the terminal's agent `text` as a prompt, once those before it are done. Refuses
   * as `admit` says, with `CONFLICT` too where the screen takes no bracketed paste, or its
   * input box is not on it, holds a draft already, or has no room on the screen for the text; `PROMPT_REFUSED` for text a TUI
   * would take for more than a message (`promptRefusal`); `PROMPT_FAILED` where the paste
   * never showed as exactly the text (or the box never switched to its shell mode at a
   * typed `!`), leaving what landed of it as a draft. All but the last write nothing.
   */
  async prompt(terminalId: string, text: string): Promise<void> {
    const refusal = promptRefusal(text, { shell: true })
    if (refusal !== undefined) throw new DomainError("PROMPT_REFUSED", refusal)
    this.host.admit(terminalId)
    const previous = this.tails.get(terminalId) ?? Promise.resolve()
    // A message's edges are no part of it, and no harness shows them: the cursor of a
    // trailing line break would sit below its box.
    const command = shellCommand(text)
    const run = previous.then(() =>
      command === undefined
        ? this.send(terminalId, normalisedText(text).trim(), false)
        : this.send(terminalId, command, true),
    )
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

  /** `text` is the message, or with `shell` the command after its `!`. */
  private async send(terminalId: string, text: string, shell: boolean): Promise<void> {
    await this.ringDone(terminalId)
    const profile = this.host.admit(terminalId)
    // The person's keys are held from before the box is looked at, so none comes between.
    const hold = await this.held(terminalId)
    let pressed = false
    // Whether the box showed the command only as a placeholder its shell would run as text.
    let unexpanded = false
    try {
      const first = await this.host.screen(terminalId)
      if (!first) throw new DomainError("TERMINAL_NOT_FOUND")
      if (!first.bracketedPaste)
        throw new DomainError(
          "CONFLICT",
          "The agent's screen takes no bracketed paste.",
          undefined,
          "no-paste",
        )
      // The box is waited on a while to read empty, in its prompt mode, as the text of the
      // prompt before this one may still show as the TUI clears it after its Enter, and a
      // command's shell mode ends a moment after its Enter. A screen it is not found on,
      // as a shell's after the agent exited, refuses the prompt before any key.
      const before = await this.emptied(terminalId, profile, first, hold.holding)
      // A text that shows whole in a box with no room for it has no first row to read,
      // and would stay as a draft the next prompt is refused for.
      if (
        !profile.collapses(text) &&
        wrappedRows(text, before.columns) + wrapMargin > profile.room(before.rows.length)
      )
        throw new DomainError(
          "CONFLICT",
          "The message is too tall for the agent's input box on this screen: make the terminal larger or the message shorter.",
          undefined,
          "too-tall",
        )
      // A request may have come while the hold was taken: no paste into its dialog.
      this.host.admit(terminalId)
      if (shell) {
        // The `!` as a key: pasted whole, Antigravity sends it to the model as text.
        if (!this.host.type(terminalId, "!")) throw this.failed()
        if (!(await this.switched(terminalId, profile, hold.holding))) {
          // It may have switched just too late: the `!` goes back out where it shows alone.
          await this.unbang(terminalId, profile)
          throw new DomainError(
            "PROMPT_FAILED",
            "The agent's input box did not switch to its shell mode.",
          )
        }
        try {
          // A request may have come meanwhile: no paste into its dialog.
          this.host.admit(terminalId)
        } catch (error) {
          // The `!` goes back out where the box shows it alone in its shell mode, so that
          // no later message runs as a command; Backspace, as Escape would end a turn.
          await this.unbang(terminalId, profile)
          throw error
        }
      }
      // A person's paste, whose line breaks the TUI takes as text, never as Enter.
      if (!this.host.type(terminalId, bracketedPaste(inPaste(text)))) throw this.failed()
      const landed = await this.landed(
        terminalId,
        text,
        profile,
        shell ? "shell" : "prompt",
        hold.holding,
      )
      unexpanded = landed === "unexpanded"
      pressed = landed === true
      // A request may have come while the paste landed, its dialog taking the Enter as an
      // answer: with one waiting now, no Enter, and the paste stays as a draft.
      if (pressed) {
        try {
          this.host.admit(terminalId)
        } catch {
          pressed = false
        }
      }
      // Their keys wait until the Enter is out, so none comes between the paste and it.
      if (pressed) this.host.type(terminalId, "\r")
    } catch (error) {
      hold.settle()
      throw error
    } finally {
      hold.release()
    }
    if (!pressed) {
      hold.settle()
      if (unexpanded)
        throw new DomainError(
          "PROMPT_FAILED",
          "The agent shows a command this long as a placeholder, which its shell would run as text: it stays in its box, unsent. Clear it in the terminal, or send a shorter command.",
        )
      throw this.failed()
    }
    // A resize as the turn starts may crash a TUI, as the doorbell's ring found of Codex.
    // The next prompt there needs no wait for it.
    const timer = setTimeout(() => this.settle(terminalId), this.settleMs)
    timer.unref()
    this.settles.set(terminalId, () => {
      clearTimeout(timer)
      hold.settle()
    })
  }

  /** Lets go of the window's resizes held after the last prompt's Enter, if any still are. */
  private settle(terminalId: string): void {
    const settle = this.settles.get(terminalId)
    this.settles.delete(terminalId)
    settle?.()
  }

  /**
   * The person's input held for the paste's time and a margin, as long text takes longer
   * to draw. A hold in force is the doorbell's ring waiting for its prompt, which a prompt
   * waits out for as long as it does a ring.
   */
  private async held(terminalId: string): Promise<ReturnType<PromptHost["hold"]>> {
    this.settle(terminalId)
    const until = Date.now() + this.ringMs
    for (;;) {
      const hold = this.host.hold(terminalId, this.budget)
      if (hold.holding()) return hold
      if (Date.now() >= until)
        throw new DomainError(
          "CONFLICT",
          "Another prompt, answer or message holds the agent's input.",
          undefined,
          "held",
        )
      // eslint-disable-next-line no-await-in-loop -- The hold is tried in turn.
      await sleep(this.pollMs)
      this.host.admit(terminalId)
    }
  }

  /**
   * The screen once the box reads empty in its prompt mode, within `emptyMs`: a draft the
   * person left, or a failed paste's, never goes, and is refused then; the TUI still
   * clearing the text of a prompt just sent does, as does a shell mode that a command's
   * Enter is leaving. A box left in its shell mode, even empty, would run a message as a
   * command: refused all the same, to be cleared in the terminal.
   */
  private async emptied(
    terminalId: string,
    profile: BoxProfile,
    first: ScreenText,
    holding: () => boolean,
  ): Promise<ScreenText> {
    const until = Date.now() + this.emptyMs
    let now = first
    for (;;) {
      const box = profile.read(now)
      if (box && box.mode === "prompt" && isEmpty(box)) return now
      if (Date.now() >= until || !holding())
        throw new DomainError(
          "CONFLICT",
          !box
            ? "The agent's input box is not on its screen."
            : box.mode === "shell"
              ? "The agent's input box is in its shell mode: clear it in the terminal first."
              : "The agent's input box holds text already: a draft the prompt would merge into.",
          undefined,
          !box ? "no-box" : box.mode === "shell" ? "shell" : "draft",
        )
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(this.pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const next = await this.host.screen(terminalId)
      if (!next) throw new DomainError("TERMINAL_NOT_FOUND")
      now = next
    }
  }

  /**
   * Whether the `!` typed into the empty box switched it to its shell mode, still empty,
   * steady on two reads running, within `pasteMs` (probed 2026-10-07).
   */
  private async switched(
    terminalId: string,
    profile: BoxProfile,
    holding: () => boolean,
  ): Promise<boolean> {
    const until = Date.now() + this.pasteMs
    let seen = false
    while (Date.now() < until && holding()) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(this.pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const after = await this.host.screen(terminalId)
      if (!after) return false
      const box = profile.read(after)
      const shown = box !== undefined && box.mode === "shell" && isEmpty(box)
      if (shown && seen) return holding()
      seen = shown
    }
    return false
  }

  /**
   * Takes the `!` typed for a shell command back out with a Backspace, where the box reads
   * empty in its shell mode: a Backspace there leaves the shell mode in every harness, idle
   * or mid-turn (probed 2026-10-07). Anything else on the screen is left as it is.
   */
  private async unbang(terminalId: string, profile: BoxProfile): Promise<void> {
    const now = await this.host.screen(terminalId)
    const box = now && profile.read(now)
    if (box && box.mode === "shell" && isEmpty(box)) this.host.type(terminalId, "\x7f")
  }

  private failed(): DomainError {
    return new DomainError("PROMPT_FAILED", "The prompt did not show in the agent's input box.")
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

  /**
   * Whether the pasted text showed in time, steady on two reads running: the box, in the
   * mode asked, holds exactly the text, or only the placeholder its harness shows for a
   * long paste (for a command, only where its shell runs the text the placeholder stands
   * for: `unexpanded` where it showed only a placeholder it would run as text). A box that
   * went into its shell mode as a message landed never counts.
   */
  private async landed(
    terminalId: string,
    text: string,
    profile: BoxProfile,
    mode: "prompt" | "shell",
    holding: () => boolean,
  ): Promise<boolean | "unexpanded"> {
    const until = Date.now() + this.pasteMs
    let last: string | undefined
    let unexpanded = false
    while (Date.now() < until && holding()) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(this.pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const after = await this.host.screen(terminalId)
      if (!after) return false
      const box = profile.read(after)
      const right = box !== undefined && box.mode === mode
      const holds = right && sameText(box.text, text)
      const placeholder = right && collapsible(text) && profile.collapsed(box)
      unexpanded = placeholder && mode === "shell" && !profile.shell.expands
      const fits = holds || (placeholder && (mode === "prompt" || profile.shell.expands))
      const key = fits ? `${box.first}:${box.last}:${box.text}` : undefined
      if (key !== undefined && key === last) return holding()
      last = key
    }
    return unexpanded ? "unexpanded" : false
  }
}
