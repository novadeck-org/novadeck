import { setTimeout as sleep } from "node:timers/promises"

import type { Terminal as Screen } from "@xterm/headless"

import { doorbellLine } from "../harnesses/harness.js"
import { coalesced } from "./coalesce.js"
import { bracketedPaste, calmMs, checkPaste, freshNonce, gate } from "./ring.js"

/** A terminal's screen as the doorbell reads it: its rows' text, and its paste mode. */
export type ScreenText = { readonly rows: readonly string[]; readonly bracketedPaste: boolean }

/** The screen's visible rows as text, and whether it takes pastes bracketed. */
export const screenText = (screen: Screen): ScreenText => {
  const buffer = screen.buffer.active
  const rows: string[] = []
  for (let row = 0; row < screen.rows; row += 1)
    rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "")
  return { rows, bracketedPaste: screen.modes.bracketedPasteMode }
}

/** What the doorbell needs of the terminal manager and messaging, by terminal. */
export type DoorbellHost = {
  /**
   * Whether messaging lets it ring: Settled, or Ready (a new session at its own prompt),
   * untouched, with messages waiting.
   */
  readonly ringable: (terminalId: string) => boolean
  /** When it became Settled, its turn ended, or Ready, its session bound; if it is either. */
  readonly settledSince: (terminalId: string) => number | undefined
  /** Whether it is Ready: a session at its own prompt before its first turn, its box empty. */
  readonly ready: (terminalId: string) => boolean
  /** Starts the ring with its nonce: the terminal is Ringing; false when it may not now. */
  readonly ring: (terminalId: string, nonce: string) => boolean
  /** The nonce of the ring under way there, if any. */
  readonly ringing: (terminalId: string) => string | undefined
  /** The ring failed: the terminal is Unknown, and its messages wait. */
  readonly ringFailed: (terminalId: string, nonce: string) => void
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /** Whether the bound instance holds the foreground; undefined where that can't be told. */
  readonly foreground: (terminalId: string) => Promise<boolean | undefined>
  /** When its window was last resized, in epoch milliseconds; 0 before any resize. */
  readonly resizedAt: (terminalId: string) => number
  /**
   * Holds the person's input to the terminal until it is released, and the app's resizes
   * of it until the hold settles, which releases the input too; a safety cap lapses each.
   * `holding` says the input is still held.
   */
  readonly hold: (terminalId: string) => {
    readonly release: () => void
    readonly settle: () => void
    readonly holding: () => boolean
  }
  /** Writes to the terminal's shell; false once it is gone. */
  readonly write: (terminalId: string, data: string) => boolean
}

export type DoorbellOptions = {
  readonly now?: () => number
  /**
   * How long after a root turn ends, or a Ready session binds, no ring starts, so any
   * harness's screen settles first (Claude Code's clears a row about 5 s after a turn), in
   * milliseconds.
   */
  readonly settleMs?: number
  /** How long a screen must be still before a ring, in milliseconds. */
  readonly calmMs?: number
  /** How often the screen is looked at after the test paste, in milliseconds. */
  readonly pollMs?: number
  /** How long the test paste may take to show, in milliseconds. */
  readonly pasteMs?: number
  /** How long after its Enter a ring waits for its doorbell prompt, in milliseconds. */
  readonly confirmMs?: number
}

/**
 * Wakes idle agents (see docs/agent-messaging.md, "The doorbell"): once messaging says a
 * terminal may be rung and its screen has been still for a while, it pastes the line as a
 * test, presses Enter only when the line landed alone, and lets the ring fail when no
 * doorbell prompt confirms it. It never presses a key after a failure, and knows nothing
 * of how any harness draws its screen. Each change to a terminal's screen or messages
 * looks again, coalesced per terminal per tick.
 */
export class Doorbell {
  private readonly now: () => number
  private readonly pollMs: number
  private readonly pasteMs: number
  private readonly confirmMs: number
  private readonly calmMs: number
  private readonly settleMs: number
  /** Each terminal's screen text as last seen, and since when. */
  private readonly still = new Map<string, { readonly text: string; readonly since: number }>()
  /** Looks at each terminal changed, once a tick. */
  private readonly schedule = coalesced(
    (terminalId) => this.check(terminalId),
    "NovaDeck's doorbell failed:",
  )
  private readonly checking = new Set<string>()
  /** Each terminal's ring pressed and awaiting its prompt: its nonce, and its hold to settle. */
  private readonly pressed = new Map<
    string,
    { readonly nonce: string; readonly settle: () => void }
  >()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(
    private readonly host: DoorbellHost,
    options: DoorbellOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? 50
    this.pasteMs = options.pasteMs ?? 1_500
    this.confirmMs = options.confirmMs ?? 5_000
    this.calmMs = options.calmMs ?? calmMs
    this.settleMs = options.settleMs ?? 6_000
  }

  /** The terminal's screen or messages changed: it is looked at again, once this tick. */
  changed(terminalId: string): void {
    const pressed = this.pressed.get(terminalId)
    // Its prompt confirmed the ring, or the ring failed: the app's resizes go on.
    if (pressed && this.host.ringing(terminalId) !== pressed.nonce) this.settle(terminalId)
    if (!this.closed) this.schedule(terminalId)
  }

  /** Forgets a terminal that stopped running. */
  forget(terminalId: string): void {
    this.settle(terminalId)
    clearTimeout(this.timers.get(terminalId))
    this.timers.delete(terminalId)
    this.still.delete(terminalId)
  }

  close(): void {
    this.closed = true
    for (const terminalId of this.pressed.keys()) this.settle(terminalId)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** Settles the hold of the terminal's ring awaiting its prompt, if any. */
  private settle(terminalId: string): void {
    this.pressed.get(terminalId)?.settle()
    this.pressed.delete(terminalId)
  }

  private later(terminalId: string, ms: number): void {
    clearTimeout(this.timers.get(terminalId))
    const timer = setTimeout(() => {
      this.timers.delete(terminalId)
      this.changed(terminalId)
    }, ms)
    timer.unref()
    this.timers.set(terminalId, timer)
  }

  private async check(terminalId: string): Promise<void> {
    if (this.closed || this.checking.has(terminalId)) return
    // Any harness's screen changes for a while after a turn, or a start: no ring before it
    // settles.
    const since = this.host.settledSince(terminalId)
    const settling = since === undefined ? 0 : since + this.settleMs - this.now()
    if (settling > 0) return this.later(terminalId, settling)
    if (!this.host.ringable(terminalId)) return
    this.checking.add(terminalId)
    try {
      const screen = await this.host.screen(terminalId)
      if (!screen) return
      const text = screen.rows.join("\n")
      const now = this.now()
      let still = this.still.get(terminalId)
      if (still?.text !== text) {
        still = { text, since: now }
        this.still.set(terminalId, still)
      }
      // A resize ends the calm too: the TUI may not have redrawn for it yet.
      const calm = now - Math.max(still.since, this.host.resizedAt(terminalId))
      if (calm < this.calmMs) return this.later(terminalId, this.calmMs - calm)
      const foreground = await this.host.foreground(terminalId)
      const verdict = gate(
        {
          ringable: this.host.ringable(terminalId),
          calmMs: calm,
          bracketedPaste: screen.bracketedPaste,
          foreground,
        },
        this.calmMs,
      )
      if (verdict === "open") await this.ring(terminalId, now - calm)
    } finally {
      this.checking.delete(terminalId)
    }
  }

  /**
   * Rings once: the test paste, with the person's input held until its Enter, and the
   * app's resizes until its prompt confirms it or it fails; Enter only once the line shows alone, twice running, and while the hold is
   * still in force; then a wait for its doorbell prompt. A resize since the calm began
   * (`calmSince`) puts the ring off untried. A ring abandoned on
   * the way fails, leaving its line, if it landed, as the person's draft.
   */
  private async ring(terminalId: string, calmSince: number): Promise<void> {
    const nonce = freshNonce()
    const line = doorbellLine(nonce)
    // Only a Ready terminal may lose a block of text as the line lands, as Codex's logo.
    const vanish = this.host.ready(terminalId)
    if (this.host.resizedAt(terminalId) > calmSince) return this.later(terminalId, this.calmMs)
    if (!this.host.ring(terminalId, nonce)) return
    const hold = this.host.hold(terminalId)
    let pressed = false
    try {
      const before = await this.host.screen(terminalId)
      if (before && this.host.write(terminalId, bracketedPaste(line))) {
        const until = this.now() + this.pasteMs
        let landed: string | undefined
        while (this.host.ringing(terminalId) === nonce) {
          // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
          await sleep(this.pollMs)
          // eslint-disable-next-line no-await-in-loop -- As above.
          const after = await this.host.screen(terminalId)
          if (!after) break
          const text = after.rows.join("\n")
          const accepted = checkPaste(before.rows, after.rows, line, { vanish }).accepted
          // Accepted twice running on the same screen, so it isn't caught mid-draw.
          if (accepted && landed === text) {
            pressed =
              hold.holding() &&
              this.host.ringing(terminalId) === nonce &&
              this.host.write(terminalId, "\r")
            break
          }
          landed = accepted ? text : undefined
          if (this.now() >= until) break
        }
      }
    } finally {
      hold.release()
    }
    if (!pressed) {
      hold.settle()
      this.host.ringFailed(terminalId, nonce)
      return
    }
    // The app's resizes wait on until its prompt confirms the ring, or it fails, as one
    // landing as the turn starts crashed Codex (0.159.3).
    this.pressed.set(terminalId, { nonce, settle: hold.settle })
    const timer = setTimeout(() => {
      if (this.host.ringing(terminalId) === nonce) this.host.ringFailed(terminalId, nonce)
      if (this.pressed.get(terminalId)?.nonce === nonce) this.settle(terminalId)
    }, this.confirmMs)
    timer.unref()
  }
}
