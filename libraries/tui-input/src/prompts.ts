import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"

import {
  fillsViewport,
  isEmpty,
  pastesWhole,
  showsTail,
  type BoxProfile,
  type InputBox,
} from "./box/box.js"
import { cursorEnded, pressKeys, type BoxKeysHost } from "./box/keys.js"
import { leftoverOf } from "./box/leftover.js"
import { endsText, sameText, unwrapped, wentFrom, wrappedRows } from "./box/text.js"
import type { HoldBudget, InputEntry, InputQueue } from "./queue.js"
import { bracketedPaste, pasteable } from "./typing.js"

/**
 * Why a prompt was not given. All but `not-switched`, `not-shown` and `unexpanded` write
 * nothing; those three leave what landed of the text as a draft.
 * - `refused`: the caller's `refuse` rule judged the text, and said why in the message, or
 *   the text holds a control character (but a tab or line break) that would press keys;
 * - `gone`: the terminal ended, or the hold on the person's input lapsed, while it waited;
 * - `no-paste`: the screen takes no bracketed paste;
 * - `no-box`: the program's input box is not on its screen, or a view of the program covers it;
 * - `shell-mode`: the box is in its shell mode already, where a message would run;
 * - `draft`: the box holds text already, which the prompt would merge into, and it may not go
 *   along with it (see `PromptMode`), or the cursor can't be put after it;
 * - `command`: the box holds a command of its program's, which the text would only add to;
 * - `too-tall`: the text shows whole in a box with no room for it on this screen;
 * - `ringing`: a delivery to the terminal outlasted the wait for it;
 * - `unrunnable`: a shell command that its shell mode can't run as written;
 * - `not-switched`: the box did not switch to its shell mode at a typed `!`;
 * - `not-shown`: the paste never showed in the box as exactly the text;
 * - `unexpanded`: the box showed a shell command only as a placeholder its shell would run
 *   as text.
 */
export type PromptRefusalReason =
  | "refused"
  | "gone"
  | "no-paste"
  | "no-box"
  | "shell-mode"
  | "draft"
  | "command"
  | "too-tall"
  | "ringing"
  | "unrunnable"
  | "not-switched"
  | "not-shown"
  | "unexpanded"

/** A prompt that was not given, with why. What the host's `admit` throws passes as it is. */
export class PromptRefusal extends Error {
  constructor(
    readonly reason: PromptRefusalReason,
    message: string,
  ) {
    super(message)
    this.name = "PromptRefusal"
  }
}

/**
 * A prompt that failed after it took words out of the box: they are on neither side now, so
 * `failure`, what it failed with, goes with them for whoever hands them back.
 */
export class WordsTaken extends Error {
  constructor(
    readonly failure: unknown,
    readonly returned: string,
  ) {
    super("The prompt failed after it took words out of the box.")
    this.name = "WordsTaken"
  }
}

/**
 * What a prompt did about what the box held, or why it could not, for the owner's log: each
 * fallback and refusal it says, so that a harness that changed shows up there.
 */
export type BoxNote =
  /** It went out with what the box held. */
  | "sent-along"
  /** Its keys emptied the box of text known to be Novadeck's. */
  | "cleared"
  /** The box left its shell mode. */
  | "left-shell"
  /** The box didn't read empty after its keys, once: it goes along with what is there. */
  | "clear-unconfirmed"
  /** The box stayed in its shell mode after its keys, once. */
  | "shell-unconfirmed"
  /** The cursor wasn't seen after the box's text: nothing was pasted. */
  | "cursor-unconfirmed"
  /** The box held a command of its program's. */
  | "command"
  /** The box in its shell mode holds what can't be handed back, or has no keys to leave it. */
  | "shell-kept"
  /** What it held can't go along with a shell command. */
  | "draft-kept"
  /** It showed no box or a view over it. */
  | "no-box"
  /** The text never showed after what the box held. */
  | "not-shown"
  /** A delivery's line is in the box, which is its own to finish. */
  | "ringing"
  /** The text has no room beside what the box holds. */
  | "too-tall"

/** What prompts need of the terminal and its owner, by terminal. */
export type PromptHost = {
  /**
   * Throws whatever refuses a prompt now (the terminal is gone, no program is there to take
   * it, or one waits on the person's answer, whose dialog would take the text), and the
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
   * Writes keys to the program as the person's, through the bookkeeping their own keys get,
   * ahead of anything their held input waits to send; false once the terminal is gone.
   */
  readonly type: (terminalId: string, data: string) => boolean
  /** Writes keys to the terminal as they are, with none of that bookkeeping; false once it is gone. */
  readonly write?: (terminalId: string, data: string) => boolean
  /**
   * The words the box's text stands for, where all of it is text Novadeck typed and knows,
   * which can leave the box and go back to who wrote them; undefined otherwise.
   */
  readonly known?: (terminalId: string, text: string) => string | undefined
  /** Whether the text is a line a delivery left in the box, which is its own to finish. */
  readonly ringLine?: (terminalId: string, text: string) => boolean
  /** Says what a prompt did about what the box held. */
  readonly note?: (terminalId: string, note: BoxNote) => void
  /** Says why a prompt was refused, whatever the box held. */
  readonly refused?: (terminalId: string, reason: PromptRefusalReason) => void
}

/**
 * How a prompt takes a box that doesn't read empty:
 * - `alone`: it doesn't: it is refused;
 * - `along`: it goes out with what the box holds, as long as the screen shows that's safe;
 * - `freed`: that, and first it takes out of the box what can go back to its writer: text
 *   Novadeck knows (`known`) and a shell mode's command, which the prompt returns.
 */
export type PromptMode = "alone" | "along" | "freed"

/**
 * What a prompt gave back: the words it took out of the box; undefined where none. `along`, the
 * words known to be Novadeck's that couldn't be taken out, and went out with it.
 */
export type PromptGiven = {
  readonly returned: string | undefined
  readonly along?: string | undefined
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
  /** How long keys that move the cursor or empty the box may take to show, in milliseconds. */
  readonly keysMs?: number
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
 * Gives programs prompts as a person would: the text as one bracketed paste with the person's
 * keys held, then Enter once the box shows exactly that text, or its placeholder for it, on
 * two reads running, both through the same bookkeeping the person's keys get. A profile reads
 * the box (see `./box`): the paste goes in only where it is empty, so it
 * never merges into a draft, and Enter only where it holds nothing else. It never presses
 * Enter after a failed check: the text stays as a draft. Prompts to one terminal take their
 * turn in the terminal's input queue, with whatever else types there, and wait for a
 * delivery under way to be confirmed, so none of them share a box. A shell command (`!` and
 * a command) goes the way a person types it, which every TUI takes: the `!` as a key, then,
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
  private readonly keysMs: number
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
    this.keysMs = options.keysMs ?? 2_000
    this.rule = options.refuse
    // The held phase is the wait for the box to read empty, for what it holds to be moved
    // past or taken out, for a shell command's `!` to switch it, and for the paste to show,
    // with a margin; the terminal's resizes stay held a while longer, past the Enter.
    const inputMs = this.emptyMs + 3 * this.keysMs + 2 * this.pasteMs + 2_000
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
   * `joined` is told, before its paste, that this prompt goes on the same line as what the box
   * holds, not on lines of its own.
   */
  async prompt(
    terminalId: string,
    text: string,
    mode: PromptMode = "alone",
    joined?: () => void,
  ): Promise<PromptGiven> {
    this.refuse(text)
    return await this.queue.run(terminalId, (entry) =>
      this.give(entry, terminalId, text, mode, joined),
    )
  }

  /**
   * Gives the prompt as the entry of the terminal's input queue that already holds its turn,
   * as the words that follow an answer, which are one entry with it.
   */
  async promptIn(entry: InputEntry, terminalId: string, text: string): Promise<void> {
    this.refuse(text)
    await this.give(entry, terminalId, text)
  }

  /**
   * The shape of the text is refused at call time; `admit` is asked in the entry's turn. A
   * control character but a tab or line break is refused whatever the rule, as it would end
   * the paste and press keys.
   */
  private refuse(text: string): void {
    const refusal = this.rule?.(text)
    if (refusal !== undefined) throw new PromptRefusal("refused", refusal)
    if (!pasteable(text))
      throw new PromptRefusal(
        "refused",
        "A prompt can't hold control characters: the program would take them as keys.",
      )
  }

  private async give(
    entry: InputEntry,
    terminalId: string,
    text: string,
    mode: PromptMode = "alone",
    joined?: () => void,
  ): Promise<PromptGiven> {
    // A message's edges are no part of it, and no TUI shows them: the cursor of a trailing
    // line break would sit below its box.
    const command = shellCommand(text)
    return command === undefined
      ? await this.send(entry, terminalId, normalised(text).trim(), false, mode, joined)
      : await this.send(entry, terminalId, command, true, mode, joined)
  }

  /** `text` is the message, or with `shell` the command after its `!`. */
  private async send(
    entry: InputEntry,
    terminalId: string,
    text: string,
    shell: boolean,
    mode: PromptMode,
    joined: (() => void) | undefined,
  ): Promise<PromptGiven> {
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
    // The person's keys are held from before the box is looked at, so none comes between.
    const hold = entry.hold(this.budget)
    if (!hold.holding()) throw this.gone()
    let pressed = false
    // Whether the box showed the command only as a placeholder its shell would run as text.
    let unexpanded = false
    let returned: string | undefined
    let left: InputBox | undefined
    let along: string | undefined
    const taken = (error: unknown): unknown => {
      if (error instanceof PromptRefusal) this.host.refused?.(terminalId, error.reason)
      return returned === undefined ? error : new WordsTaken(error, returned)
    }
    try {
      const first = await this.host.screen(terminalId)
      if (!first) throw this.gone()
      if (!first.bracketedPaste)
        throw new PromptRefusal("no-paste", "The screen takes no bracketed paste.")
      // The box is waited on a while to read empty, in its prompt mode, as the text of the
      // prompt before this one may still show as the TUI clears it after its Enter, and a
      // command's shell mode ends a moment after its Enter. A screen it is not found on,
      // as a shell's after the program exited, refuses the prompt before any key.
      let before = await this.emptied(terminalId, profile, first, hold.holding, mode !== "alone")
      if (mode !== "alone") {
        // A request may have come while the box was waited on: no key into its dialog.
        this.host.admit(terminalId)
        const room = await this.room(terminalId, profile, before, shell, mode, hold.holding)
        ;({ screen: before, returned, left, along } = room)
      }
      // A text that shows whole in a box with no room for it has no first row to read,
      // and would stay as a draft the next prompt is refused for. Beside what the box holds,
      // and a blank line, a box that shows a tail needs no more room: its end is what's read.
      const held = left ? left.last - left.first + 3 : 0
      if (
        !profile.collapses(typed) &&
        !(left && profile.viewport) &&
        held + wrappedRows(typed, before.columns) + wrapMargin > profile.room(before.rows.length)
      ) {
        if (mode !== "alone") this.host.note?.(terminalId, "too-tall")
        throw new PromptRefusal(
          "too-tall",
          "The text is too tall for the input box on this screen.",
        )
      }
      // A request may have come while the hold was taken: no paste into its dialog.
      this.host.admit(terminalId)
      if (shell) {
        // The `!` as a key: pasted whole, some TUIs send it to the model as text.
        if (!this.host.type(terminalId, "!")) throw this.notShown()
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
      // A person's paste, whose line breaks the TUI takes as text, never as Enter.
      // After text the box holds, a blank line sets it apart, keeps the prompt's lines its own
      // for its record, and closes a picker that text may have open, whose Enter would pick
      // from it (probed 2026-11-06 on all three harnesses). Where a paste is keys, that line
      // break would be an Enter, which submits what the box holds and leaves the prompt behind:
      // a space does the same but for the prompt's lines, which its record is told of.
      const keys = left !== undefined && profile.pastesAsKeys?.() === true
      if (left && !pastesWhole(profile, typed)) {
        this.host.note?.(terminalId, "draft-kept")
        throw this.draft()
      }
      if (keys) joined?.()
      const pasted = left ? `${keys ? " " : "\n\n"}${typed}` : typed
      if (!this.host.type(terminalId, bracketedPaste(inPaste(pasted)))) throw this.notShown()
      const landed = await this.landed(
        terminalId,
        typed,
        profile,
        shell ? "shell" : "prompt",
        hold.holding,
        left,
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
      // The person's keys wait until the Enter is out, so none comes between the paste and it.
      // An Enter that can't be written leaves the text as a draft of a terminal gone.
      if (pressed && !this.host.type(terminalId, "\r")) throw this.gone()
    } catch (error) {
      hold.settle()
      throw taken(error)
    } finally {
      hold.release()
    }
    if (!pressed) {
      hold.settle()
      if (unexpanded)
        throw taken(
          new PromptRefusal(
            "unexpanded",
            "The box shows a command this long as a placeholder, which its shell would run as text: it stays in the box, unsent.",
          ),
        )
      if (left) this.host.note?.(terminalId, "not-shown")
      throw taken(this.notShown())
    }
    if (left) this.host.note?.(terminalId, "sent-along")
    // The next prompt waits until the session it started is there: a program given one while
    // it still starts its conversation may start another with it, and the first is lost
    // (one TUI did, 160 ms apart: about 1 in 60 CI runs, a few percent under heavy local
    // load). A session that binds late holds up whatever is queued behind this prompt, a
    // prompt, an interrupt or a delivery, for up to `bindMs`.
    if (starts) await this.bindDone(terminalId)
    // A resize as the turn starts may crash a TUI, as a delivery's ring found of one. The
    // next entry there takes this hold over, with the resizes it holds.
    hold.settleAfter(this.settleMs)
    return { returned, along }
  }

  /**
   * Makes the box ready for a prompt that needn't find it empty, from the screen `emptied`
   * left: takes out what it may, and puts the cursor after what stays. Each step goes once and
   * is read back: where it doesn't confirm, the prompt goes on from what the screen shows, or
   * is refused with nothing pasted, never pressing the keys again.
   */
  private async room(
    terminalId: string,
    profile: BoxProfile,
    screen: ScreenText,
    shell: boolean,
    mode: PromptMode,
    holding: () => boolean,
  ): Promise<{
    readonly screen: ScreenText
    readonly returned: string | undefined
    readonly left: InputBox | undefined
    readonly along?: string | undefined
  }> {
    const none = { screen, returned: undefined, left: undefined }
    const state = leftoverOf(profile, screen)
    switch (state.kind) {
      case "none":
        this.host.note?.(terminalId, "no-box")
        throw new PromptRefusal("no-box", "The input box is not on the screen.")
      case "empty":
        return none
      case "command":
        this.host.note?.(terminalId, "command")
        throw new PromptRefusal("command", "The input box holds a command of the program's.")
      case "shell":
        return await this.leftShell(terminalId, profile, screen, state, mode, holding)
      case "text":
        break
    }
    const { box, tail } = state
    if (this.host.ringLine?.(terminalId, box.text)) {
      this.host.note?.(terminalId, "ringing")
      throw new PromptRefusal("ringing", "A line is being delivered to the terminal.")
    }
    const words = mode === "freed" ? this.host.known?.(terminalId, box.text) : undefined
    // Rows that read as a known prompt may be only the end of what's there: its keys would take
    // them and bring up the rest, words of no one's left behind in the box.
    if (words !== undefined && tail) {
      this.host.note?.(terminalId, "draft-kept")
      throw this.draft()
    }
    let now = screen
    if (words !== undefined && profile.erase) {
      now = await this.cursorEnd(terminalId, profile, box, screen, holding)
      const emptied = await this.keyed(
        terminalId,
        profile.erase(box),
        holding,
        (after) => leftoverOf(profile, after).kind === "empty",
      )
      if (emptied) {
        this.host.note?.(terminalId, "cleared")
        return { screen: emptied, returned: words, left: undefined }
      }
      this.host.note?.(terminalId, "clear-unconfirmed")
      now = (await this.host.screen(terminalId)) ?? now
    }
    const still = leftoverOf(profile, now)
    const same = still.kind === "text" && sameText(still.box.text, box.text) ? still : undefined
    // What the keys left of it is no longer what the box held: nothing goes on over it, and
    // what they took goes back all the same, or it would be nowhere.
    const read = words !== undefined && !same ? profile.read(now) : undefined
    const went = read && wentFrom(words!, read.text)
    if (went !== undefined) {
      this.host.note?.(terminalId, "draft-kept")
      throw new WordsTaken(this.draft(), went)
    }
    if (shell || !same) {
      this.host.note?.(terminalId, "draft-kept")
      throw this.draft()
    }
    const after = await this.cursorEnd(terminalId, profile, same.box, now, holding)
    return { screen: after, returned: undefined, left: same.box, along: words }
  }

  /**
   * Leaves the box's shell mode: empty, by its keys; holding a command, by the same, which then
   * goes back to who typed it. One that shows only as a placeholder or its tail can't, and
   * stays there; it is refused, as is a program with no such keys.
   */
  private async leftShell(
    terminalId: string,
    profile: BoxProfile,
    screen: ScreenText,
    state: { readonly box: InputBox; readonly tail: boolean },
    mode: PromptMode,
    holding: () => boolean,
  ): Promise<{
    readonly screen: ScreenText
    readonly returned: string | undefined
    readonly left: undefined
  }> {
    const { box, tail } = state
    const { leave } = profile.shell
    const empty = isEmpty(box)
    const unknown = tail || profile.stands(box.text)
    if (!leave || (!empty && (mode !== "freed" || unknown))) {
      this.host.note?.(terminalId, "shell-kept")
      throw this.inShell()
    }
    if (!empty) await this.cursorEnd(terminalId, profile, box, screen, holding)
    const emptied = await this.keyed(
      terminalId,
      leave(box),
      holding,
      (after) => leftoverOf(profile, after).kind === "empty",
    )
    const words = unwrapped(box.text, profile.textWidth(screen.columns)).trim()
    if (!emptied) {
      this.host.note?.(terminalId, "shell-unconfirmed")
      // What the keys took of a command goes back all the same, or it would be nowhere.
      const now = await this.host.screen(terminalId)
      const read = now && profile.read(now)
      const went = read && !empty ? wentFrom(words, read.text) : undefined
      throw went === undefined ? this.inShell() : new WordsTaken(this.inShell(), `!${went}`)
    }
    this.host.note?.(terminalId, "left-shell")
    return { screen: emptied, returned: empty ? undefined : `!${words}`, left: undefined }
  }

  /** The screen with the cursor after what the box holds, or refused with nothing pasted. */
  private async cursorEnd(
    terminalId: string,
    profile: BoxProfile,
    box: InputBox,
    screen: ScreenText,
    holding: () => boolean,
  ): Promise<ScreenText> {
    const timing = { pollMs: this.pollMs, keysMs: this.keysMs }
    const keys = this.keysHost(terminalId, holding)
    const moved = await cursorEnded(keys, timing, profile, box, screen)
    if (moved) return moved
    this.host.note?.(terminalId, "cursor-unconfirmed")
    throw this.draft()
  }

  /** See `pressKeys`. */
  private async keyed(
    terminalId: string,
    keys: string,
    holding: () => boolean,
    reached: (screen: ScreenText) => boolean,
  ): Promise<ScreenText | undefined> {
    const timing = { pollMs: this.pollMs, keysMs: this.keysMs }
    return await pressKeys(this.keysHost(terminalId, holding), timing, keys, reached)
  }

  private keysHost(terminalId: string, holding: () => boolean): BoxKeysHost {
    return {
      admit: () => void this.host.admit(terminalId),
      write: (keys) => this.host.write?.(terminalId, keys) ?? false,
      screen: () => this.host.screen(terminalId),
      holding,
    }
  }

  /**
   * The screen once the box reads empty in its prompt mode, with no view of the program over
   * it, steady on two reads running, within `emptyMs`: a draft the person left, or a failed
   * paste's, never goes, and is refused then; the TUI still clearing the text of a prompt
   * just sent does, as does a shell mode that a command's Enter is leaving. One empty read is
   * not enough, as a key the person typed just before the hold may not show on it yet. A box
   * left in its shell mode, even empty, would run a message as a command: refused all the
   * same. An empty box read off a view (`BoxProfile.overlay`, a history search or a transcript)
   * is no box: the paste would go to the view, and its Enter act in it. A hold that lapsed
   * meanwhile refuses it as `gone`, whatever the box. With `leftover`, a box still holding text
   * or in its shell mode once `emptyMs` passed is no refusal here: the screen is given back.
   */
  private async emptied(
    terminalId: string,
    profile: BoxProfile,
    first: ScreenText,
    holding: () => boolean,
    leftover = false,
  ): Promise<ScreenText> {
    const until = Date.now() + this.emptyMs
    let now = first
    // Where the box read empty on the read before, if it did.
    let seen: string | undefined
    for (;;) {
      if (!holding()) throw this.gone()
      const box = profile.read(now)
      const view = box !== undefined && profile.overlay(now)
      const empty = box !== undefined && box.mode === "prompt" && isEmpty(box) && !view
      const key = empty ? `${box.first}:${box.last}` : undefined
      if (key !== undefined && key === seen) return now
      // A box first seen empty as the time is up is given its second read.
      if (Date.now() >= until && (key === undefined || seen !== undefined)) {
        if (!box || view || empty) {
          if (leftover) this.host.note?.(terminalId, "no-box")
          throw new PromptRefusal("no-box", "The input box is not on the screen.")
        }
        if (leftover) return now
        throw box.mode === "shell" ? this.inShell() : this.draft()
      }
      seen = key
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

  private draft(): PromptRefusal {
    return new PromptRefusal(
      "draft",
      "The input box holds text already: a draft the prompt would merge into.",
    )
  }

  private inShell(): PromptRefusal {
    return new PromptRefusal("shell-mode", "The input box is in its shell mode.")
  }

  private notShown(): PromptRefusal {
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
   * Whether the box holds `left`, what it held, then nothing but the placeholder of what was
   * pasted after it, which the blank line the paste leads with goes into (probed 2026-11-06: the
   * record holds both whole, that line between).
   */
  private follows(profile: BoxProfile, box: InputBox, left: InputBox): boolean {
    const at = box.text.lastIndexOf("[")
    if (at <= 0) return false
    const placeholder = { ...box, text: box.text.slice(at).replace(/\s+/g, " ") }
    return profile.collapsed(placeholder) && sameText(box.text.slice(0, at), left.text)
  }

  /**
   * Whether the pasted text showed in time, steady on two reads running: the box, in the
   * mode asked, holds exactly the text, or only its tail where the box is as tall as its
   * viewport (see `showsTail`), or only the placeholder its TUI shows for a
   * long paste (for a command, only where its shell runs the text the placeholder stands
   * for: `unexpanded` where it showed only a placeholder it would run as text). A box that
   * went into its shell mode as a message landed never counts, nor one under a view. After
   * `left`, what the box held, the box must hold that and then the text.
   */
  private async landed(
    terminalId: string,
    text: string,
    profile: BoxProfile,
    mode: "prompt" | "shell",
    holding: () => boolean,
    left?: InputBox,
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
      // A view opened over the box as the text landed would take the Enter.
      const right = box !== undefined && box.mode === mode && !profile.overlay(after)
      // A text taller than the box's viewport shows only its tail, the box then full.
      const whole = left ? `${left.text}\n\n${text}` : text
      const holds =
        right &&
        (sameText(box.text, whole) ||
          showsTail(profile, box, after.rows.length, whole) ||
          (left !== undefined &&
            fillsViewport(profile, left, after.rows.length) &&
            endsText(box.text, text)))
      const placeholder =
        right &&
        collapsible(text) &&
        (left ? this.follows(profile, box, left) : profile.collapsed(box))
      unexpanded = placeholder && mode === "shell" && !profile.shell.expands
      const fits = holds || (placeholder && (mode === "prompt" || profile.shell.expands))
      const key = fits ? `${box.first}:${box.last}:${box.text}` : undefined
      if (key !== undefined && key === last) return holding()
      last = key
    }
    return unexpanded ? "unexpanded" : false
  }
}
