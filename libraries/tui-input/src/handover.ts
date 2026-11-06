import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"

import { isEmpty, showsTail, type BoxProfile, type InputBox } from "./box/box.js"
import { cursorEnded, pressKeys, type BoxKeysHost } from "./box/keys.js"
import { leftoverOf } from "./box/leftover.js"
import { sameText, unwrapped, wentFrom, wrappedRows } from "./box/text.js"
import { collapsible, type BoxNote } from "./prompts.js"
import type { HoldBudget, InputEntry, InputQueue } from "./queue.js"
import { bracketedPaste } from "./typing.js"

/** What a handover needs of the terminal and its owner, by terminal. */
export type HandoverHost = {
  /** Throws whatever refuses keys now, as a request waiting; gives how its box reads. */
  readonly admit: (terminalId: string) => BoxProfile
  /** The nonce of the line being delivered there, if any. */
  readonly ringing: (terminalId: string) => string | undefined
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /** Writes keys as the person's, through the bookkeeping theirs get; false once it is gone. */
  readonly type: (terminalId: string, data: string) => boolean
  /** Writes keys as they are, with none of that bookkeeping; false once it is gone. */
  readonly write: (terminalId: string, data: string) => boolean
  /** The words the box's text stands for, where all of it is text Novadeck typed and knows. */
  readonly known: (terminalId: string, text: string) => string | undefined
  /** Whether the text is a line a delivery left in the box, which is its own to finish. */
  readonly ringLine: (terminalId: string, text: string) => boolean
  /** When a prompt's Enter was last pressed there, whose text the box may still show. */
  readonly enteredAt: (terminalId: string) => number | undefined
  /** Why a prompt's text may not go, as it would leave a picker open; undefined where it may. */
  readonly refuse: (text: string) => string | undefined
  /** Says what a handover did, or why it didn't. */
  readonly note: (terminalId: string, note: HandoverNote) => void
}

/** What a handover did, or why it left the box alone, for the owner's log. */
export type HandoverNote =
  /** The box's words went to the chat. */
  | "taken"
  /** The chat's words went to the box. */
  | "placed"
  /** The box read differently on two reads. */
  | "unsteady"
  /** It may show only a tail, or holds what stands for more than it shows. */
  | "unreadable"
  | Extract<BoxNote, "clear-unconfirmed" | "shell-unconfirmed" | "cursor-unconfirmed">
  /** The text's shape would open a picker there. */
  | "shape"
  /** The box isn't empty, or there's none. */
  | "not-empty"
  /** The words never showed in the box. */
  | "not-shown"
  /** A delivery is under way there. */
  | "ringing"
  /** A delivery's line is in the box, with anything beside it or not. */
  | "ring-line"
  /** The words have no room in the box. */
  | "too-tall"
  /** The box holds a command of its program's. */
  | "command"
  /** The screen takes no bracketed paste. */
  | "no-paste"

export type HandoverOptions = {
  readonly pollMs?: number
  /** How long the box must stay the same before it is taken from, in milliseconds. */
  readonly steadyMs?: number
  /** How long after a prompt's Enter the box may still show its text, in milliseconds. */
  readonly emptyMs?: number
  /** How long keys may take to show, in milliseconds. */
  readonly keysMs?: number
  /** How long a paste may take to show, in milliseconds. */
  readonly pasteMs?: number
  /** How long a take waits for a delivery under way to end, in milliseconds. */
  readonly ringMs?: number
}

/**
 * Hands what a person is writing between a program's input box and the chat over it, one input
 * as far as they can tell. Each direction takes its turn in the terminal's input queue, so it
 * never races a delivery or a prompt, and goes only where the screen shows that's safe: anything
 * else leaves things as they are, logged, the box's text showing as what it is (`boxView`).
 */
export class Handovers {
  private readonly pollMs: number
  private readonly steadyMs: number
  private readonly emptyMs: number
  private readonly keysMs: number
  private readonly pasteMs: number
  private readonly ringMs: number
  private readonly budget: HoldBudget

  constructor(
    private readonly host: HandoverHost,
    private readonly queue: InputQueue,
    options: HandoverOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 50
    this.steadyMs = options.steadyMs ?? 300
    this.emptyMs = options.emptyMs ?? 3_000
    this.keysMs = options.keysMs ?? 2_000
    this.pasteMs = options.pasteMs ?? 5_000
    this.ringMs = options.ringMs ?? 10_000
    const inputMs = this.emptyMs + 3 * this.keysMs + this.pasteMs + 2_000
    this.budget = { inputMs, sizeMs: inputMs }
  }

  /**
   * Takes what the box holds out of it, once it has read the same for `steadyMs` and all of it
   * can be read: the words, as typed, a shell mode's command with its `!`; undefined where
   * nothing was taken, the box then as it was but for a clear that didn't confirm.
   */
  async take(terminalId: string): Promise<string | undefined> {
    await this.ringOver(terminalId)
    return await this.queue.run(terminalId, (entry) => this.taking(entry, terminalId))
  }

  /** Waits for a delivery under way there to end, as what the box holds is seen just once. */
  private async ringOver(terminalId: string): Promise<void> {
    const until = Date.now() + this.ringMs
    while (this.host.ringing(terminalId) !== undefined && Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The ring is looked at in turn.
      await sleep(this.pollMs)
    }
  }

  /**
   * Puts `text` in the box without its Enter, where the box is empty and the text would open no
   * picker there, a leading `!` as a person types it, so the box takes it in its shell mode.
   * False where it didn't: the text is its writer's still.
   */
  async put(terminalId: string, text: string): Promise<boolean> {
    return await this.queue.run(terminalId, (entry) => this.putting(entry, terminalId, text))
  }

  private keysHost(terminalId: string, holding: () => boolean): BoxKeysHost {
    return {
      admit: () => void this.host.admit(terminalId),
      write: (keys) => this.host.write(terminalId, keys),
      screen: () => this.host.screen(terminalId),
      holding,
    }
  }

  /** The box once it has read the same for `steadyMs`; undefined where it didn't. */
  private async steady(
    terminalId: string,
    profile: BoxProfile,
    holding: () => boolean,
  ): Promise<ScreenText | undefined> {
    const box = (screen: ScreenText) => {
      const read = profile.read(screen)
      return read && `${read.mode}:${read.first}:${read.last}:${read.text}`
    }
    const entered = this.host.enteredAt(terminalId)
    const wait = entered === undefined ? 0 : entered + this.emptyMs - Date.now()
    if (wait > 0) await sleep(wait)
    const first = await this.host.screen(terminalId)
    if (!first) return undefined
    await sleep(this.steadyMs)
    const second = await this.host.screen(terminalId)
    if (!second || !holding()) return undefined
    if (box(first) === box(second)) return second
    this.host.note(terminalId, "unsteady")
    return undefined
  }

  private async taking(entry: InputEntry, terminalId: string): Promise<string | undefined> {
    const profile = this.host.admit(terminalId)
    if (this.host.ringing(terminalId) !== undefined) {
      this.host.note(terminalId, "ringing")
      return undefined
    }
    const hold = entry.hold(this.budget)
    const { holding } = hold
    try {
      const screen = await this.steady(terminalId, profile, holding)
      if (!screen) return undefined
      const state = leftoverOf(profile, screen)
      if (state.kind === "none" || state.kind === "empty") return undefined
      // The chat can neither send it nor put it back: it stays, and shows.
      if (state.kind === "command") {
        this.host.note(terminalId, "command")
        return undefined
      }
      const { box, tail } = state
      if (isEmpty(box)) return undefined
      if (this.host.ringLine(terminalId, box.text)) {
        this.host.note(terminalId, "ring-line")
        return undefined
      }
      const keys = box.mode === "shell" ? profile.shell.leave?.(box) : profile.erase?.(box)
      if (tail || profile.stands(box.text) || keys === undefined) {
        this.host.note(terminalId, "unreadable")
        return undefined
      }
      const host = this.keysHost(terminalId, holding)
      const timing = { pollMs: this.pollMs, keysMs: this.keysMs }
      if (!(await cursorEnded(host, timing, profile, box, screen))) {
        this.host.note(terminalId, "cursor-unconfirmed")
        return undefined
      }
      const words = this.wordsOf(terminalId, profile, box, screen)
      const emptied = await pressKeys(
        host,
        timing,
        keys,
        (after) => leftoverOf(profile, after).kind === "empty",
      )
      if (!emptied) {
        const shell = box.mode === "shell"
        this.host.note(terminalId, shell ? "shell-unconfirmed" : "clear-unconfirmed")
        // Keys taken late, or in part: what they took is in the box no longer, and goes on,
        // what's left there to be taken after it. A box not read says nothing went.
        const now = await this.host.screen(terminalId)
        const read = now && profile.read(now)
        const body = box.mode === "shell" ? words.slice(1) : words
        const went = read && wentFrom(body, read.text)
        return went !== undefined && box.mode === "shell" ? `!${went}` : went
      }
      this.host.note(terminalId, "taken")
      return words
    } finally {
      hold.settle()
    }
  }

  /** The words the box holds, as they were given where Novadeck knows them, else as typed. */
  private wordsOf(
    terminalId: string,
    profile: BoxProfile,
    box: InputBox,
    screen: ScreenText,
  ): string {
    const known = this.host.known(terminalId, box.text)
    if (known !== undefined) return known
    const words = unwrapped(box.text, profile.textWidth(screen.columns)).trim()
    return box.mode === "shell" ? `!${words}` : words
  }

  private async putting(entry: InputEntry, terminalId: string, text: string): Promise<boolean> {
    const words = text.trim()
    if (this.host.refuse(words) !== undefined) {
      this.host.note(terminalId, "shape")
      return false
    }
    const profile = this.host.admit(terminalId)
    if (this.host.ringing(terminalId) !== undefined) {
      this.host.note(terminalId, "ringing")
      return false
    }
    const shell = words.startsWith("!")
    const body = shell ? words.slice(1).trim() : words
    // Its shell mode would run the placeholder of a long command as text.
    if (shell && !profile.shell.expands && (collapsible(body) || profile.collapses(body))) {
      this.host.note(terminalId, "shape")
      return false
    }
    const hold = entry.hold(this.budget)
    const { holding } = hold
    try {
      const screen = await this.steady(terminalId, profile, holding)
      if (!screen || leftoverOf(profile, screen).kind !== "empty") {
        this.host.note(terminalId, "not-empty")
        return false
      }
      // Unbracketed, a line break of the text would be an Enter.
      if (!screen.bracketedPaste) {
        this.host.note(terminalId, "no-paste")
        return false
      }
      if (
        !profile.collapses(body) &&
        wrappedRows(body, screen.columns) + 1 > profile.room(screen.rows.length)
      ) {
        this.host.note(terminalId, "too-tall")
        return false
      }
      // A request may have come while the box was read: no key into its dialog.
      this.host.admit(terminalId)
      // As a person types it, as a paste with its `!` isn't a shell command to every program.
      if (shell && !(await this.typedBang(terminalId, profile, holding))) {
        await this.unbang(terminalId, profile)
        return false
      }
      try {
        this.host.admit(terminalId)
      } catch (error) {
        if (shell) await this.unbang(terminalId, profile)
        throw error
      }
      const paste = body.replace(/\r\n?|\n/g, "\r")
      if (!this.host.type(terminalId, bracketedPaste(paste))) return false
      if (await this.shown(terminalId, profile, body, shell ? "shell" : "prompt", holding)) {
        this.host.note(terminalId, "placed")
        return true
      }
      this.host.note(terminalId, "not-shown")
      return false
    } finally {
      hold.settle()
    }
  }

  private async typedBang(
    terminalId: string,
    profile: BoxProfile,
    holding: () => boolean,
  ): Promise<boolean> {
    if (!this.host.type(terminalId, "!")) return false
    const until = Date.now() + this.keysMs
    while (Date.now() < until && holding()) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(this.pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const after = await this.host.screen(terminalId)
      const box = after && profile.read(after)
      if (box?.mode === "shell" && isEmpty(box)) return true
    }
    this.host.note(terminalId, "shell-unconfirmed")
    return false
  }

  /** Takes a `!` typed back out, so no later line of the person's runs as a command. */
  private async unbang(terminalId: string, profile: BoxProfile): Promise<void> {
    const now = await this.host.screen(terminalId)
    const box = now && profile.read(now)
    if (box?.mode === "shell" && isEmpty(box)) this.host.type(terminalId, "\x7f")
  }

  /** Whether the text showed in the box, whole, as its tail, or as its placeholder. */
  private async shown(
    terminalId: string,
    profile: BoxProfile,
    text: string,
    mode: InputBox["mode"],
    holding: () => boolean,
  ): Promise<boolean> {
    const until = Date.now() + this.pasteMs
    while (Date.now() < until && holding()) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(this.pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const after = await this.host.screen(terminalId)
      const box = after && profile.read(after)
      if (box?.mode !== mode || !after) continue
      const whole = sameText(box.text, text) || showsTail(profile, box, after.rows.length, text)
      if (whole || profile.collapsed(box)) return true
    }
    return false
  }
}
