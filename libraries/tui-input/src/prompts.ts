import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"

import { isEmpty, sameText, showsTail, wrappedRows, type BoxProfile } from "./box.js"
import { PromptRefusal } from "./errors.js"
import { type HoldBudget, type InputEntry, type InputQueue } from "./queue.js"
import { bracketedPaste } from "./typing.js"

/** What prompts need of the terminal and its owner, by terminal. */
export type PromptHost = {
  /**
   * Throws whatever refuses a prompt now (the terminal is gone, no program is there to take
   * it, or one waits on the user's answer, whose dialog would take the text), and the
   * prompt lets it through as it is. Returns how the input box of the program admitted
   * reads off the screen, which the prompt keeps for all it does: a program that has gone
   * by then leaves a screen that box is not found on.
   */
  readonly admit: (terminalId: string) => BoxProfile
  /**
   * Whether the program has a session bound: false for one shown at its prompt whose first
   * session its first prompt starts (see `admit`).
   */
  readonly bound: (terminalId: string) => boolean
  /** The nonce of the line being delivered there, if any. */
  readonly ringing: (terminalId: string) => string | undefined
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /**
   * Writes keys to the program as the user's, through the bookkeeping their own keys get,
   * ahead of anything their held input waits to send; false once the terminal is gone.
   */
  readonly type: (terminalId: string, data: string) => boolean
}

export type PromptOptions = {
  /** How often the screen is looked at after the paste, in milliseconds. */
  readonly pollMs?: number
  /** How long the paste may take to show, in milliseconds. */
  readonly pasteMs?: number
  /** How long a delivery under way is waited for, in milliseconds. */
  readonly ringMs?: number
  /** How long after its Enter the window's resizes stay held, in milliseconds. */
  readonly settleMs?: number
  /** How long a first prompt's session is waited on to bind after its Enter, in milliseconds. */
  readonly bindMs?: number
  /** How long a box holding text is waited on to read empty before the prompt is refused. */
  readonly emptyMs?: number
  /**
   * The caller's rule for the text a prompt may carry: why it can't be given, or undefined
   * where it can. It judges the text as it was given, and a leading `!` is a shell command
   * to it too; it is asked at call time, before the terminal's turn in its queue.
   */
  readonly refuse?: (text: string) => string | undefined
}

/**
 * Whether a TUI may show a paste as a placeholder (like "[Pasted text #1 +4 lines]") rather
 * than its text: more than one line, or long.
 */
export const collapsible = (text: string): boolean => /[\r\n]/.test(text) || text.length > 200

/** Rows added to the estimate of a text's height, as TUIs' wrapping may differ a little. */
const wrapMargin = 1

/** A prompt's lines as a terminal takes them in a paste: its line breaks are bare returns. */
const inPaste = (text: string): string => text.replace(/\r\n?|\n/g, "\r")

/**
 * The text with its line breaks as line feeds: a CRLF or a lone CR is one line break.
 * A caller that refuses prompts by its own rule (`refuse`) reads them with its own copy of
 * this and of `shellCommand`, kept apart on purpose: the two must agree, and the caller's
 * tests should check that they route a `!` the same way.
 */
const normalised = (text: string): string => text.replace(/\r\n?/g, "\n")

/**
 * The shell command a prompt gives, where it starts with `!`: the rest, trimmed, which a
 * TUI runs in its shell mode once `!` is typed in its empty box; undefined for any other
 * prompt. A caller's own copy must agree with it (see `normalised`).
 */
const shellCommand = (text: string): string | undefined => {
  const trimmed = normalised(text).trim()
  return trimmed.startsWith("!") ? trimmed.slice(1).trim() : undefined
}

/**
 * Gives programs prompts as a user would: the text as one bracketed paste with the user's
 * keys held, then Enter once the box shows exactly that text, or its placeholder for it, on
 * two reads running, both through the same bookkeeping the user's keys get. A profile reads
 * the box (see `./box`): the paste goes in only where it is empty, so it
 * never merges into a draft, and Enter only where it holds nothing else. It never presses
 * Enter after a failed check: the text stays as a draft. Prompts to one terminal take their
 * turn in the terminal's input queue, with whatever else types there, and wait for a
 * delivery under way to be confirmed, so none of them share a box. A shell command (`!` and
 * a command) goes the way a user types it, which every TUI takes: the `!` as a key, then,
 * once the box reads empty in its shell mode, the command as the paste, and Enter once the
 * box holds exactly it. A message never goes into a box in its shell mode, where Enter
 * would run it. It fails closed: a screen the box is not found on, whatever the reason,
 * writes nothing.
 */
export class Prompts {
  private readonly pollMs: number
  private readonly pasteMs: number
  private readonly ringMs: number
  private readonly settleMs: number
  private readonly emptyMs: number
  private readonly bindMs: number
  private readonly budget: HoldBudget
  private readonly rule: ((text: string) => string | undefined) | undefined

  constructor(
    private readonly host: PromptHost,
    private readonly queue: InputQueue,
    options: PromptOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 50
    this.pasteMs = options.pasteMs ?? 5_000
    this.ringMs = options.ringMs ?? 10_000
    this.settleMs = options.settleMs ?? 1_000
    this.emptyMs = options.emptyMs ?? 3_000
    this.bindMs = options.bindMs ?? 5_000
    this.rule = options.refuse
    // The held phase is the wait for the box to read empty, for a shell command's `!` to
    // switch it, and for the paste to show, with a margin; the terminal's resizes stay held
    // a while longer, past the Enter.
    const inputMs = this.emptyMs + 2 * this.pasteMs + 2_000
    // The resizes stay held through the wait for a session to bind, too.
    this.budget = { inputMs, sizeMs: inputMs + this.bindMs + this.settleMs }
  }

  /**
   * Gives the terminal's program `text` as a prompt, once those before it in the terminal's
   * input queue are done. Throws a `PromptRefusal` (see its reasons) for text the `refuse`
   * rule judges, before the queue; in its turn, for what `admit` throws, which passes as it
   * is, and for a screen that takes no bracketed paste, shows no input box, holds a draft
   * already or has no room for the text, or where the paste never showed as exactly the
   * text, or as its tail in a full box (or the box never switched to its shell mode at a
   * typed `!`), leaving what landed of it as a draft. All but the last write nothing.
   */
  async prompt(terminalId: string, text: string): Promise<void> {
    this.refuse(text)
    await this.queue.run(terminalId, (entry) => this.give(entry, terminalId, text))
  }

  /**
   * Gives the prompt as the entry of the terminal's input queue that already holds its turn,
   * as the words that follow an answer, which are one entry with it.
   */
  async promptIn(entry: InputEntry, terminalId: string, text: string): Promise<void> {
    this.refuse(text)
    await this.give(entry, terminalId, text)
  }

  /** The shape of the text is refused at call time; `admit` is asked in the entry's turn. */
  private refuse(text: string): void {
    const refusal = this.rule?.(text)
    if (refusal !== undefined) throw new PromptRefusal("refused", refusal)
  }

  private async give(entry: InputEntry, terminalId: string, text: string): Promise<void> {
    // A message's edges are no part of it, and no TUI shows them: the cursor of a trailing
    // line break would sit below its box.
    const command = shellCommand(text)
    return command === undefined
      ? await this.send(entry, terminalId, normalised(text).trim(), false)
      : await this.send(entry, terminalId, command, true)
  }

  /** `text` is the message, or with `shell` the command after its `!`. */
  private async send(
    entry: InputEntry,
    terminalId: string,
    text: string,
    shell: boolean,
  ): Promise<void> {
    await this.ringDone(terminalId)
    const profile = this.host.admit(terminalId)
    // A command as its TUI's shell mode runs it the way sh runs what was written; one its
    // shell can't run as written means is refused before any key.
    const given = shell && profile.shell.command ? profile.shell.command(text) : text
    if (given === undefined)
      throw new PromptRefusal(
        "unrunnable",
        "The shell mode runs only a command's first line, and these lines can't be joined to run as written.",
      )
    const typed = given || text
    // The first prompt of a program shown before its session binds starts that session, as a
    // shell command does only where its TUI starts one for it.
    const starts = !this.host.bound(terminalId) && (!shell || profile.shell.starts)
    // The user's keys are held from before the box is looked at, so none comes between.
    const hold = entry.hold(this.budget)
    if (!hold.holding()) throw this.gone()
    let pressed = false
    // Whether the box showed the command only as a placeholder its shell would run as text.
    let unexpanded = false
    try {
      const first = await this.host.screen(terminalId)
      if (!first) throw this.gone()
      if (!first.bracketedPaste)
        throw new PromptRefusal("no-paste", "The screen takes no bracketed paste.")
      // The box is waited on a while to read empty, in its prompt mode, as the text of the
      // prompt before this one may still show as the TUI clears it after its Enter, and a
      // command's shell mode ends a moment after its Enter. A screen it is not found on,
      // as a shell's after the program exited, refuses the prompt before any key.
      const before = await this.emptied(terminalId, profile, first, hold.holding)
      // A text that shows whole in a box with no room for it has no first row to read,
      // and would stay as a draft the next prompt is refused for.
      if (
        !profile.collapses(typed) &&
        wrappedRows(typed, before.columns) + wrapMargin > profile.room(before.rows.length)
      )
        throw new PromptRefusal(
          "too-tall",
          "The text is too tall for the input box on this screen.",
        )
      // A request may have come while the hold was taken: no paste into its dialog.
      this.host.admit(terminalId)
      if (shell) {
        // The `!` as a key: pasted whole, some TUIs send it to the model as text.
        if (!this.host.type(terminalId, "!")) throw this.failed()
        if (!(await this.switched(terminalId, profile, hold.holding))) {
          // It may have switched just too late: the `!` goes back out where it shows alone.
          await this.unbang(terminalId, profile)
          throw new PromptRefusal("not-switched", "The input box did not switch to its shell mode.")
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
      // A user's paste, whose line breaks the TUI takes as text, never as Enter.
      if (!this.host.type(terminalId, bracketedPaste(inPaste(typed)))) throw this.failed()
      const landed = await this.landed(
        terminalId,
        typed,
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
      // The user's keys wait until the Enter is out, so none comes between the paste and it.
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
        throw new PromptRefusal(
          "unexpanded",
          "The box shows a command this long as a placeholder, which its shell would run as text: it stays in the box, unsent.",
        )
      throw this.failed()
    }
    // The next prompt waits until the session it started is there: a program given one while
    // it still starts its conversation may start another with it, and the first is lost
    // (one TUI did, 160 ms apart: about 1 in 60 CI runs, a few percent under heavy local
    // load). A session that binds late holds up whatever is queued behind this prompt, a
    // prompt, an interrupt or a delivery, for up to `bindMs`.
    if (starts) await this.bindDone(terminalId)
    // A resize as the turn starts may crash a TUI, as a delivery's ring found of one. The
    // next entry there takes this hold over, with the resizes it holds.
    hold.settleAfter(this.settleMs)
  }

  /**
   * The screen once the box reads empty in its prompt mode, within `emptyMs`: a draft the
   * user left, or a failed paste's, never goes, and is refused then; the TUI still
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
        throw !box
          ? new PromptRefusal("no-box", "The input box is not on the screen.")
          : box.mode === "shell"
            ? new PromptRefusal("shell-mode", "The input box is in its shell mode.")
            : new PromptRefusal(
                "draft",
                "The input box holds text already: a draft the prompt would merge into.",
              )
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(this.pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const next = await this.host.screen(terminalId)
      if (!next) throw this.gone()
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
   * empty in its shell mode: a Backspace there leaves the shell mode in every TUI probed, idle
   * or mid-turn (probed 2026-10-07). Anything else on the screen is left as it is.
   */
  private async unbang(terminalId: string, profile: BoxProfile): Promise<void> {
    const now = await this.host.screen(terminalId)
    const box = now && profile.read(now)
    if (box && box.mode === "shell" && isEmpty(box)) this.host.type(terminalId, "\x7f")
  }

  private failed(): PromptRefusal {
    return new PromptRefusal("not-shown", "The prompt did not show in the input box.")
  }

  private gone(): PromptRefusal {
    return new PromptRefusal("gone", "The terminal is gone.")
  }

  /** Waits for the program's session to bind; one that never does is no failure of the prompt. */
  private async bindDone(terminalId: string): Promise<void> {
    const until = Date.now() + this.bindMs
    while (!this.host.bound(terminalId) && Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The binding is looked at in turn.
      await sleep(this.pollMs)
    }
  }

  /** Waits for the delivery under way, if any, to end; one that outlasts `ringMs` refuses the prompt. */
  private async ringDone(terminalId: string): Promise<void> {
    const until = Date.now() + this.ringMs
    while (this.host.ringing(terminalId) !== undefined) {
      if (Date.now() >= until)
        throw new PromptRefusal("ringing", "A line is being delivered to the terminal.")
      // eslint-disable-next-line no-await-in-loop -- The ring is looked at in turn.
      await sleep(this.pollMs)
    }
  }

  /**
   * Whether the pasted text showed in time, steady on two reads running: the box, in the
   * mode asked, holds exactly the text, or only its tail where the box is as tall as its
   * viewport (see `showsTail`), or only the placeholder its TUI shows for a
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
      // A text taller than the box's viewport shows only its tail, the box then full.
      const holds =
        right && (sameText(box.text, text) || showsTail(profile, box, after.rows.length, text))
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
