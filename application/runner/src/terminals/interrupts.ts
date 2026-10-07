import { setTimeout as sleep } from "node:timers/promises"

import type { InterruptResult } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { endsText, isEmpty, sameText, type BoxProfile, type InputBox } from "../harnesses/box.js"
import type { ScreenText } from "./screen.js"

/** The waits of an interrupt, in milliseconds. */
export type InterruptOptions = {
  /** How long it looks for the turn's prompt put back in the agent's box. */
  readonly restoreMs?: number
  /** How long the screen must be still without it before it is taken as not coming. */
  readonly restoreCalmMs?: number
  /**
   * How long after an interrupt the next one of the terminal waits before it looks at the
   * turn: its hooks may still report the turn working a moment after Escape ended it, and
   * a second Escape then would stop nothing.
   */
  readonly settleMs?: number
}

/** What interrupts need of the terminal manager and messaging, by terminal. */
export type InterruptHost = {
  /**
   * Throws what refuses keys to the terminal's agent now: `TERMINAL_NOT_FOUND`,
   * `TERMINAL_EXITED`, `RUNTIME_CLOSING`, and `CONFLICT` where no agent is there to take
   * them or one waits on the person's answer, whose dialog would take them.
   */
  readonly admit: (terminalId: string) => void
  /** Whether the terminal is running and its agent's turn is working. */
  readonly working: (terminalId: string) => boolean
  /** Whether the terminal is still running. */
  readonly alive: (terminalId: string) => boolean
  /** How the box of the agent bound, or shown at its prompt, reads; undefined where none. */
  readonly profile: (terminalId: string) => BoxProfile | undefined
  /** The turn's prompt as its hooks told it; undefined where they did not. */
  readonly prompt: (terminalId: string) => string | undefined
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /**
   * Writes keys to the agent as the person's, through the bookkeeping their own keys get;
   * false once the terminal is gone.
   */
  readonly type: (terminalId: string, data: string) => boolean
  /** Writes keys to the terminal as they are, with none of that bookkeeping; false once it is gone. */
  readonly write: (terminalId: string, data: string) => boolean
}

/** The fewest rows a harness's viewport can be and say a box is full by its height. */
const minViewport = 2

const notCleared = (): DomainError =>
  new DomainError(
    "BOX_NOT_CLEARED",
    "The turn is stopped, but the agent's input box holds the message you queued: clear it in the terminal.",
  )

/**
 * Stops agents' turns as the person's Escape does, and leaves their boxes as they were
 * (see `Terminals.interrupt`). The caller runs each in the terminal's input queue.
 */
export class Interrupts {
  /** When each terminal's latest interrupt has settled, while it has not, in epoch milliseconds. */
  private readonly settles = new Map<string, number>()
  private readonly restoreMs: number
  private readonly restoreCalmMs: number
  private readonly settleMs: number

  constructor(
    private readonly host: InterruptHost,
    options: InterruptOptions = {},
  ) {
    this.restoreMs = options.restoreMs ?? 2_000
    this.restoreCalmMs = options.restoreCalmMs ?? 500
    this.settleMs = options.settleMs ?? 1_000
  }

  /**
   * Interrupts the terminal's agent after the settle wait of the interrupt before it, which
   * its hooks may not have caught up with yet.
   */
  async interrupt(terminalId: string): Promise<InterruptResult> {
    const settling = (this.settles.get(terminalId) ?? 0) - Date.now()
    if (settling > 0) await sleep(settling)
    try {
      return await this.once(terminalId)
    } finally {
      const until = Date.now() + this.settleMs
      this.settles.set(terminalId, until)
      setTimeout(() => {
        if (this.settles.get(terminalId) === until) this.settles.delete(terminalId)
      }, this.settleMs).unref()
    }
  }

  private async once(terminalId: string): Promise<InterruptResult> {
    const { host } = this
    const none = { returned: null }
    host.admit(terminalId)
    if (!host.working(terminalId)) return none
    // How its box reads, and the keys that clear it, if its harness puts text back.
    const profile = host.profile(terminalId)
    // The turn's prompt, as its hooks told it, ends with the turn Escape ends.
    const prompt = host.prompt(terminalId)
    // Only an empty box has text put back alone: text the person has typed there would be
    // merged with it, and is theirs.
    const first = profile ? await host.screen(terminalId) : undefined
    const boxBefore = first && profile?.read(first)
    const emptyBefore = boxBefore !== undefined && isEmpty(boxBefore)
    const queued = first !== undefined && profile?.queued(first) === true
    if (!host.working(terminalId)) return none
    host.type(terminalId, "\x1b")
    if (!profile || !emptyBefore) return none
    if (prompt === undefined && !queued) return none
    let box = await this.settled(terminalId, profile)
    // Claude Code and Codex send what was queued as the next turn, or a steer, which a
    // second Escape stops; Claude Code then puts that message back in its box. One Escape
    // does nothing at an idle prompt, and two are never written here.
    if (box !== undefined && isEmpty(box) && queued && host.alive(terminalId)) {
      host.type(terminalId, "\x1b")
      box = await this.settled(terminalId, profile)
    }
    if (!host.alive(terminalId)) return none
    // Text that may be there and can't be seen is left, and said.
    if (box === undefined && queued) throw notCleared()
    if (box === undefined || isEmpty(box)) return none
    // The prompt put back is the turn's own, which the chat shows already; with messages
    // queued, what is there is theirs (the hooks name the queued one the person's latest).
    // Claude Code puts it back as its text, never as a "[Pasted text]" placeholder, however
    // long (probed 2026-10-07, `e2e/probes/interrupted-paste.e2e.ts`); a prompt taller than
    // its box shows only its tail, the box then as tall as it gets.
    const rows = first?.rows.length ?? 0
    const viewport = profile.viewport?.(rows) ?? Infinity
    // A viewport of one row is every box's: on a screen too small to know it, none is full.
    const full = viewport >= minViewport && box.last - box.first + 1 >= viewport
    const restored =
      !queued &&
      prompt !== undefined &&
      (sameText(box.text, prompt) || (full && endsText(box.text, prompt)))
    // Words given back in the box's shell mode are a shell command, `!` and all.
    const words = box.mode === "shell" ? `!${box.text.trim()}` : box.text.trim()
    // A placeholder stands for words that clearing would lose: they are left, and said.
    if (!profile.clear || (!restored && profile.collapsed(box))) throw notCleared()
    if (!(await this.cleared(terminalId, profile, box))) throw notCleared()
    return restored ? none : { returned: words }
  }

  /**
   * Clears the text of the box with the profile's keys, written, not typed (the box is
   * empty after them, which the person's keys never say), and looks that it reads empty,
   * writing them again up to twice if not. False where it does not.
   */
  private async cleared(terminalId: string, profile: BoxProfile, box: InputBox): Promise<boolean> {
    const { host } = this
    let now = box
    for (let attempt = 0; attempt < 3; attempt += 1) {
      host.write(terminalId, profile.clear!(now))
      const until = Date.now() + this.restoreCalmMs
      while (Date.now() < until) {
        // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
        await sleep(50)
        // eslint-disable-next-line no-await-in-loop -- As above.
        const after = await host.screen(terminalId)
        const read = after && profile.read(after)
        if (!after || !host.alive(terminalId)) return false
        if (read === undefined) continue
        if (isEmpty(read)) return true
        now = read
      }
    }
    return false
  }

  /**
   * The box once it has held still: steady on two reads running where it holds text, or
   * for `restoreCalmMs` where it is empty, the harness putting something back in it
   * quickly if it does at all. Whatever it reads after `restoreMs`; undefined where the
   * terminal is gone or the box is not found.
   */
  private async settled(terminalId: string, profile: BoxProfile): Promise<InputBox | undefined> {
    const { host } = this
    const until = Date.now() + this.restoreMs
    let key: string | undefined
    let since = Date.now()
    let last: InputBox | undefined
    while (Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(50)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const after = await host.screen(terminalId)
      if (!after || !host.alive(terminalId)) return undefined
      const box = profile.read(after)
      const now = box ? `${box.first}:${box.last}:${box.text}` : undefined
      if (now !== key) since = Date.now()
      else if (box && (!isEmpty(box) || Date.now() - since >= this.restoreCalmMs)) return box
      key = now
      last = box
    }
    return last
  }
}
