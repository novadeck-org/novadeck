import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"
import { doorbellLine, hookShellSlackMs } from "@novadeck/harness-core/harness"

import type { Waits } from "../messaging/delivery.js"
import { coalesced } from "./coalesce.js"
import type { InputEntry, InputQueue } from "./input-queue.js"
import { bracketedPaste, calmMs, changedRows, checkPaste, freshNonce, gate } from "./ring.js"

/**
 * Where the doorbell tells what it decided, line by line, for the e2e trace to show (see
 * `e2e/trace.ts`); nothing listens in the app.
 */
export const tracer: { sink?: (terminalId: string, line: string) => void } = {}

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
  /**
   * Starts the ring with its nonce: the terminal is Ringing; false when it may not now, as
   * the agent's activity says a turn or subagents run (checked here, just before the paste).
   */
  readonly ring: (terminalId: string, nonce: string) => boolean
  /** The nonce of the ring under way there, if any. */
  readonly ringing: (terminalId: string) => string | undefined
  /** The ring failed: the terminal is Unknown, and its messages wait. */
  readonly ringFailed: (terminalId: string, nonce: string, ours?: boolean) => void
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /** Whether the bound instance holds the foreground; undefined where that can't be told. */
  readonly foreground: (terminalId: string) => Promise<boolean | undefined>
  /** When its window was last resized, in epoch milliseconds; 0 before any resize. */
  readonly resizedAt: (terminalId: string) => number
  /**
   * Whether the agent is idle but Fresh, Drafting or Unknown (not ringable by its state), with
   * messages waiting: its screen is looked at for an empty box.
   */
  readonly stalled: (terminalId: string) => boolean
  /**
   * What the screen shows of the agent's own box, by its harness's reader: `empty` (it takes
   * a prompt and holds nothing, no request pending), else why not rung.
   */
  readonly reading: (terminalId: string, screen: ScreenText) => "empty" | "starting" | Waits
  /**
   * A mark that changes with every root turn event and every key of the person's: a ring
   * that failed three times is tried again only after it does.
   */
  readonly stamp: (terminalId: string) => string
  /**
   * The screen, read at `readAt`, showed the box empty: Drafting, Unknown or Fresh becomes
   * Ready, unless the person pressed a key since.
   */
  readonly emptied: (terminalId: string, readAt: number) => void
  /** Why it can't be rung now, as its screen shows; null once nothing keeps it. */
  readonly blocked: (terminalId: string, waits: Waits | null) => void
  /**
   * The nonce of the doorbell line that is all the agent's box holds, left by a ring that
   * failed with the person typing nothing since (`Box.ours`); undefined otherwise.
   */
  readonly leftover: (terminalId: string, screen: ScreenText) => string | undefined
  /** Starts the submission of that line, under its nonce: the terminal is Ringing; false when it may not now. */
  readonly ringLeftover: (terminalId: string, nonce: string) => boolean
  /** How much longer the screen is not believed, after a Stop that left a prompt queued; 0 if none. */
  readonly barred?: (terminalId: string) => number
  /** Writes to the terminal's shell; false once it is gone. */
  readonly write: (terminalId: string, data: string) => boolean
  /**
   * On Windows, whether the agent's input box shows on the screen, empty and taking a
   * prompt (see `GateFacts.inputBox`); undefined where a bracketed paste can't press keys.
   */
  readonly inputBox?: (terminalId: string, screen: ScreenText) => boolean | undefined
}

export type DoorbellOptions = {
  readonly now?: () => number
  /**
   * How long after a root turn ends, or a Ready session binds, no ring starts, so any
   * harness's screen settles first (Claude Code's clears a row about 5 s after a turn), in
   * milliseconds.
   */
  readonly settleMs?: number
  /**
   * Whether the agent's input box is looked at before and as a ring begins (default true);
   * false only for a stand-in TUI that draws none.
   */
  readonly boxCheck?: boolean
  /** How long a new session may show no box before it is said to wait for the person, in milliseconds. */
  readonly startMs?: number
  /**
   * How long the screen is watched before the test paste for rows that change by
   * themselves (a clock, a timer, a subagent's output), in milliseconds.
   */
  readonly watchMs?: number
  /** How long a row's changes count towards its ticking, in milliseconds. */
  readonly tickWindowMs?: number
  /** The first wait before a stalled terminal's screen is looked at again; it doubles, in milliseconds. */
  readonly recheckMs?: number
  /** The longest that wait grows to, in milliseconds. */
  readonly recheckMaxMs?: number
  /** How long a screen must be still before a ring, in milliseconds. */
  readonly calmMs?: number
  /** How often the screen is looked at after the test paste, in milliseconds. */
  readonly pollMs?: number
  /** How long the test paste may take to show, in milliseconds. */
  readonly pasteMs?: number
  /** How long after its Enter a ring waits for its doorbell prompt, in milliseconds. */
  readonly confirmMs?: number
  /** The platform the harnesses' hooks run on, which sets `confirmMs` by default. */
  readonly platform?: NodeJS.Platform
}

/**
 * How long after its Enter a ring waits by default for the doorbell prompt that confirms
 * it, in milliseconds: the hook that tells it starts in the harness's shell first, which
 * may take long on some platforms (see `hookShellSlackMs`), as on Windows, where a ring
 * failed before its Codex hook came, and the message waited for the turn's Stop.
 */
export const confirmMs = (platform: NodeJS.Platform): number => 5_000 + hookShellSlackMs(platform)

// How much longer than its test paste a ring holds the person's input, in milliseconds: a
// safety cap, with room for the last looks and the Enter.
const inputCapMs = 1_500

// The longest it holds the app's resizes, in milliseconds: a safety cap beyond the wait for
// the ring's prompt to confirm it.
const sizeCapMs = 8_000

/**
 * Wakes idle agents (see docs/agent-messaging.md, "The doorbell"): once messaging says a
 * terminal may be rung and its screen has been still for a while, it pastes the line as a
 * test, presses Enter only when the line landed alone, and lets the ring fail when no
 * doorbell prompt confirms it. It never presses a key after a failure, and knows nothing
 * of how any harness draws its screen. Each change to a terminal's screen or messages
 * looks again, coalesced per terminal per tick. A ring takes its turn in the terminal's
 * input queue, after the prompts, answers and interrupts before it, and looks at the
 * screen once more when its turn comes.
 */
export class Doorbell {
  private readonly now: () => number
  private readonly pollMs: number
  private readonly pasteMs: number
  private readonly confirmMs: number
  private readonly calmMs: number
  private readonly settleMs: number
  private readonly boxCheck: boolean
  private readonly watchMs: number
  private readonly tickWindowMs: number
  /** The rows of each terminal's screen as last seen, and when each row changed, lately. */
  private readonly seen = new Map<
    string,
    { readonly rows: readonly string[]; readonly changes: Map<number, number[]> }
  >()
  /** The nonce of the leftover line to submit, found by the look at an idle terminal. */
  private readonly leftovers = new Map<string, string>()
  private readonly maxFailures = 3
  /** How long a new session may show no box before it is said to wait for the person. */
  private readonly startMs: number
  /** Since when each Fresh terminal has shown no box. */
  private readonly starting = new Map<string, number>()
  private readonly recheckMs: number
  private readonly recheckMaxMs: number
  /** How long until each stalled terminal's screen is looked at next, as it backs off. */
  private readonly backoff = new Map<string, number>()
  /** How many rings in a row failed in each terminal, and the last failed one's nonce. */
  private readonly failures = new Map<
    string,
    { count: number; nonce: string; retryAt: number; stamp: string }
  >()
  /** Before when a stalled terminal's screen is not looked at again, after one that was not calm. */
  private readonly notBefore = new Map<string, number>()
  /** When each stalled terminal's screen was last looked at. */
  private readonly looked = new Map<string, number>()
  /** The stamp each stalled terminal had when its screen was last looked at. */
  private readonly lookedStamp = new Map<string, string>()
  /** Each terminal's screen text as last seen, and since when. */
  private readonly still = new Map<string, { readonly text: string; readonly since: number }>()
  /** Looks at each terminal changed, once a tick. */
  private readonly schedule = coalesced(
    (terminalId) => this.check(terminalId),
    "Novadeck's doorbell failed:",
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
    private readonly queue: InputQueue,
    options: DoorbellOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.pollMs = options.pollMs ?? 50
    // A loaded Windows runner stalls the runner for a second at a time (probed on CI), so
    // the screen is looked at less often than the test paste's check needs: more time there.
    this.pasteMs =
      options.pasteMs ?? ((options.platform ?? process.platform) === "win32" ? 4_000 : 1_500)
    this.confirmMs = options.confirmMs ?? confirmMs(options.platform ?? process.platform)
    this.calmMs = options.calmMs ?? calmMs
    this.settleMs = options.settleMs ?? 6_000
    this.boxCheck = options.boxCheck ?? true
    this.startMs = options.startMs ?? 5_000
    this.watchMs = options.watchMs ?? 1_100
    this.tickWindowMs = options.tickWindowMs ?? 10_000
    this.recheckMs = options.recheckMs ?? 1_000
    this.recheckMaxMs = options.recheckMaxMs ?? 15_000
  }

  /** The terminal's screen or messages changed: it is looked at again, once this tick. */
  changed(terminalId: string): void {
    this.poke(terminalId)
  }

  private poke(terminalId: string): void {
    const pressed = this.pressed.get(terminalId)
    // Its prompt confirmed the ring, or the ring failed: the app's resizes go on.
    if (pressed && this.host.ringing(terminalId) !== pressed.nonce) {
      // Confirmed (no failure of its nonce was told): the failures before it are over.
      if (this.failures.get(terminalId)?.nonce !== pressed.nonce) this.failures.delete(terminalId)
      this.settle(terminalId)
    }
    if (!this.closed) this.schedule(terminalId)
  }

  /** Forgets a terminal that stopped running. */
  forget(terminalId: string): void {
    this.settle(terminalId)
    clearTimeout(this.timers.get(terminalId))
    this.timers.delete(terminalId)
    this.still.delete(terminalId)
    this.backoff.delete(terminalId)
    this.failures.delete(terminalId)
    this.seen.delete(terminalId)
    this.looked.delete(terminalId)
    this.lookedStamp.delete(terminalId)
    this.notBefore.delete(terminalId)
    this.starting.delete(terminalId)
    this.leftovers.delete(terminalId)
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
      this.poke(terminalId)
    }, ms)
    timer.unref()
    this.timers.set(terminalId, timer)
  }

  private async check(terminalId: string): Promise<void> {
    if (this.closed || this.checking.has(terminalId)) return
    this.checking.add(terminalId)
    try {
      if ((await this.open(terminalId)) === undefined) {
        const nonce = this.leftovers.get(terminalId)
        if (nonce)
          await this.queue.run(terminalId, (entry) => this.submit(entry, terminalId, nonce))
        return
      }
      await this.queue.run(terminalId, (entry) => this.ring(entry, terminalId))
    } catch (error) {
      this.note(terminalId, `check threw: ${String(error)}`)
      throw error
    } finally {
      this.checking.delete(terminalId)
    }
  }

  /**
   * When the screen's calm began, if the terminal may be rung now: messaging says so, the
   * settle window has passed, and the screen has been still for a while, takes a bracketed
   * paste and is the foreground's. Otherwise undefined, with a later look where one is due.
   */
  private note(terminalId: string, line: string): void {
    tracer.sink?.(terminalId, line)
  }

  private async open(terminalId: string, again = false): Promise<number | undefined> {
    this.leftovers.delete(terminalId)
    // Any harness's screen changes for a while after a turn, or a start: no ring before it
    // settles.
    const since = this.host.settledSince(terminalId)
    const settling = since === undefined ? 0 : since + this.settleMs - this.now()
    if (settling > 0) {
      this.note(terminalId, `settling for ${Math.round(settling)} ms`)
      this.later(terminalId, settling)
      return undefined
    }
    const ringable = this.host.ringable(terminalId)
    const stalled = !ringable && this.host.stalled(terminalId)
    if (ringable || stalled)
      this.note(terminalId, `look: ringable ${ringable}, stalled ${stalled}, again ${again}`)
    if (!ringable && !stalled) {
      this.backoff.delete(terminalId)
      this.notBefore.delete(terminalId)
      // A prompt the harness submits itself after a Stop has its hook late: the screen is
      // believed again once the bar has passed.
      const bar = this.host.barred?.(terminalId) ?? 0
      if (bar > 0) {
        this.note(terminalId, `screen not believed for ${Math.round(bar)} ms (a queued prompt)`)
        this.later(terminalId, bar + 50)
      }
      return undefined
    }
    // Rings that failed three times in a row wait for a root turn event or a key of the
    // person's: the doorbell isn't getting through, and trying on would only add lines.
    if (this.capped(terminalId)) {
      this.host.blocked(terminalId, "failed")
      return undefined
    }
    // A stalled terminal's screen is read at most once a calm window, and after one that was
    // not calm, not before its growing wait is over: output that streams, or a terminal that
    // keeps redrawing (Windows' console does), is looked at less and less, never starved of a
    // look by the changes themselves. A key of the person's or a turn event (a new stamp) is
    // a real change: it ends the wait, and the screen is read once a calm window has passed.
    if (stalled && !again) {
      const news = this.lookedStamp.get(terminalId) !== this.host.stamp(terminalId)
      // A key or a turn event starts the backing off over: what follows it is news.
      if (news) {
        this.backoff.delete(terminalId)
        this.notBefore.delete(terminalId)
      }
      const quiet = Math.max(
        (this.looked.get(terminalId) ?? Number.NEGATIVE_INFINITY) + this.calmMs,
        this.notBefore.get(terminalId) ?? Number.NEGATIVE_INFINITY,
      )
      const wait = quiet - this.now()
      if (wait > 0) {
        this.note(terminalId, `look put off for ${Math.round(wait)} ms`)
        this.later(terminalId, wait)
        return undefined
      }
    }
    if (stalled) {
      this.looked.set(terminalId, this.now())
      this.lookedStamp.set(terminalId, this.host.stamp(terminalId))
    }
    const screen = await this.host.screen(terminalId)
    if (!screen) return undefined
    const now = this.now()
    this.observe(terminalId, screen.rows, now)
    const text = screen.rows.join("\n")
    let still = this.still.get(terminalId)
    if (still?.text !== text) {
      still = { text, since: now }
      this.still.set(terminalId, still)
    }
    // A resize ends the calm too: the TUI may not have redrawn for it yet.
    const calm = now - Math.max(still.since, this.host.resizedAt(terminalId))
    if (calm < this.calmMs) {
      this.note(terminalId, `screen not calm: ${Math.round(calm)} of ${this.calmMs} ms`)
      // A stalled terminal whose screen keeps changing is looked at less and less often.
      if (stalled) {
        const wait = Math.max(this.calmMs - calm, this.nextWait(terminalId))
        this.notBefore.set(terminalId, now + wait)
        this.later(terminalId, wait)
      } else this.later(terminalId, this.calmMs - calm)
      return undefined
    }
    if (stalled) {
      await this.recover(terminalId, screen, now - calm)
      return undefined
    }
    const foreground = await this.host.foreground(terminalId)
    const inputBox = this.boxCheck ? this.host.inputBox?.(terminalId, screen) : undefined
    const verdict = gate(
      {
        ringable: this.host.ringable(terminalId),
        calmMs: calm,
        bracketedPaste: screen.bracketedPaste,
        foreground,
        ...(inputBox !== undefined && { inputBox }),
      },
      this.calmMs,
    )
    this.note(
      terminalId,
      `gate ${verdict} (foreground ${String(foreground)}, input box ${String(inputBox)}, bracketed paste ${screen.bracketedPaste})`,
    )
    if (verdict === "open") {
      this.backoff.delete(terminalId)
      this.notBefore.delete(terminalId)
      this.host.blocked(terminalId, null)
      return now - calm
    }
    if (verdict !== "not-ringable") this.refused(terminalId, screen, verdict)
    return undefined
  }

  /** How long until the screen is looked at again, growing with each look, up to the cap. */
  private nextWait(terminalId: string): number {
    const wait = Math.min(
      (this.backoff.get(terminalId) ?? this.recheckMs / 2) * 2,
      this.recheckMaxMs,
    )
    this.backoff.set(terminalId, wait)
    // Redraws that change nothing don't shorten it: the next look waits until it is over.
    this.notBefore.set(terminalId, this.now() + wait)
    return wait
  }

  /**
   * The gate refused a calm screen: it says why, as the screen shows, and looks again with
   * growing waits, so no refusal leaves the terminal silent and forgotten.
   */
  private refused(terminalId: string, screen: ScreenText, verdict: string): void {
    const reading = verdict === "no-input-box" ? this.host.reading(terminalId, screen) : "away"
    this.host.blocked(
      terminalId,
      reading === "empty" || reading === "starting" ? "dialog" : reading,
    )
    this.later(terminalId, this.nextWait(terminalId))
  }

  /** Notes which rows of the terminal's screen changed since it was last seen. */
  private observe(terminalId: string, rows: readonly string[], now: number): void {
    const seen = this.seen.get(terminalId)
    const changes = seen?.changes ?? new Map<number, number[]>()
    if (seen)
      for (const at of changedRows(seen.rows, rows))
        changes.set(at, [...(changes.get(at) ?? []), now])
    this.seen.set(terminalId, { rows, changes })
  }

  /** The rows that changed at least twice lately, with nothing of ours to cause it: ticking. */
  private ticking(terminalId: string, now: number): ReadonlySet<number> {
    const rows = new Set<number>()
    const changes = this.seen.get(terminalId)?.changes
    if (!changes) return rows
    for (const [at, times] of changes) {
      const lately = times.filter((time) => now - time <= this.tickWindowMs)
      if (lately.length === 0) changes.delete(at)
      else changes.set(at, lately)
      if (lately.length >= 2) rows.add(at)
    }
    return rows
  }

  /** Whether three rings in a row failed and nothing has happened in the terminal since. */
  private capped(terminalId: string): boolean {
    const failed = this.failures.get(terminalId)
    if (!failed || failed.count < this.maxFailures) return false
    if (failed.stamp === this.host.stamp(terminalId)) return true
    this.failures.delete(terminalId)
    return false
  }

  /**
   * A ring failed: the terminal is Unknown, and rung again later, after longer waits each
   * time. One given up before it pasted anything (`counted` false) doesn't count. Its line
   * is left Novadeck's own (`ours`) only where the paste check had accepted it: never after a
   * rejection, which may mean the line went into a widget.
   */
  private failed(terminalId: string, nonce: string, counted = true, ours = false): void {
    const before = this.failures.get(terminalId)
    const count = (before?.count ?? 0) + (counted ? 1 : 0)
    const wait = Math.min(this.recheckMs * 2 ** Math.max(count, 1), this.recheckMaxMs)
    this.failures.set(terminalId, {
      count,
      nonce,
      retryAt: this.now() + wait,
      stamp: this.host.stamp(terminalId),
    })
    this.note(
      terminalId,
      `ring ${nonce} failed (counted ${counted}, ours ${ours}); count ${count}, next try in ${wait} ms`,
    )
    this.host.ringFailed(terminalId, nonce, ours)
    // Unknown and idle, it is looked at again once the wait is over.
    this.later(terminalId, wait)
  }

  /**
   * Looks at the screen of an idle agent whose state keeps it from ringing (Fresh, Drafting
   * or Unknown, with messages waiting), once the screen is calm: its own box empty and
   * taking a prompt makes it Ready, rung as any Ready terminal is; otherwise says why it
   * can't be (text in its box, a dialog, a question) and looks again, with growing waits.
   * It never types: only the ring's own test paste does, once Ready.
   */
  private async recover(terminalId: string, screen: ScreenText, calmSince: number): Promise<void> {
    const now = this.now()
    const reading = this.host.reading(terminalId, screen)
    this.note(terminalId, `reading ${reading}`)
    // A question open on the person is theirs first, whatever the box shows.
    if (reading === "asking") {
      this.host.blocked(terminalId, "asking")
      this.later(terminalId, this.nextWait(terminalId))
      return
    }
    // The line a failed ring left, with nothing of the person's: Novadeck's own, submitted
    // once the wait after the failure is over.
    const left = this.host.leftover(terminalId, screen)
    if (left !== undefined) {
      const failed = this.failures.get(terminalId)
      if (failed && now < failed.retryAt) {
        this.later(terminalId, failed.retryAt - now)
        return
      }
      // The same gate as a ring: the agent holds the terminal and it takes a paste.
      const foreground = await this.host.foreground(terminalId)
      if (foreground === false || !screen.bracketedPaste) {
        this.refused(terminalId, screen, "away")
        return
      }
      this.host.blocked(terminalId, null)
      this.leftovers.set(terminalId, left)
      return
    }
    if (reading === "empty") {
      // A ring that failed leaves the terminal Unknown and empty again, as a paste that never
      // lands would: tried again with growing waits, not at once.
      const failed = this.failures.get(terminalId)
      if (failed && now < failed.retryAt) {
        this.later(terminalId, failed.retryAt - now)
        return
      }
      this.host.blocked(terminalId, null)
      this.backoff.delete(terminalId)
      this.notBefore.delete(terminalId)
      this.note(terminalId, "box read empty: Ready")
      this.host.emptied(terminalId, calmSince)
      // Ready now: looked at again once this look is done, for the ring itself.
      this.later(terminalId, 0)
      return
    }
    // A new session with no box yet is starting, or waits at a trust, update or login screen
    // for the person: after a while it says so.
    if (reading === "starting") {
      const since = this.starting.get(terminalId) ?? now
      this.starting.set(terminalId, since)
      this.host.blocked(terminalId, now - since >= this.startMs ? "dialog" : null)
    } else {
      this.starting.delete(terminalId)
      this.host.blocked(terminalId, reading)
    }
    this.later(terminalId, this.nextWait(terminalId))
  }

  /**
   * Rings once, in its turn: the test paste, with the person's input held until its Enter, and the
   * app's resizes until its prompt confirms it or it fails; Enter only once the line shows alone, twice running, and while the hold is
   * still in force; then a wait for its doorbell prompt. The entries before it may have
   * changed the screen, so the terminal is looked at again first. A resize since the calm began
   * puts the ring off untried. A ring abandoned on
   * the way fails, leaving its line, if it landed, as the person's draft.
   */
  private async ring(entry: InputEntry, terminalId: string): Promise<void> {
    if (this.closed) return
    const calmSince = await this.open(terminalId)
    if (calmSince === undefined) return
    // Watch the screen for rows that change by themselves, which the paste's check then
    // lets be. A change in any other row means the screen is not calm after all.
    const ticking = await this.watch(terminalId)
    if (ticking === undefined) return this.later(terminalId, this.calmMs)
    const nonce = freshNonce()
    const line = doorbellLine(nonce)
    this.note(terminalId, `ring ${nonce} begins (ticking rows ${[...ticking].join(",") || "none"})`)
    // Only a Ready terminal may lose a block of text as the line lands, as Codex's logo.
    const vanish = this.host.ready(terminalId)
    if (this.host.resizedAt(terminalId) > calmSince) return this.later(terminalId, this.calmMs)
    if (!this.host.ring(terminalId, nonce)) return
    const hold = entry.hold({ inputMs: this.pasteMs + inputCapMs, sizeMs: sizeCapMs })
    let pressed = false
    // Whether the paste check accepted the line: then it is alone in the agent's box.
    let acceptedTwice = false
    try {
      const before = await this.host.screen(terminalId)
      // The box is looked at again now, on every platform: a key of the person's or a view
      // since the calm may have left text in it or something else in its place.
      if (before && this.boxCheck && this.host.inputBox?.(terminalId, before) === false) {
        hold.settle()
        this.failed(terminalId, nonce, false)
        return
      }
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
          const checked = checkPaste(before.rows, after.rows, line, { vanish, ticking })
          const accepted = checked.accepted
          if (!accepted && this.now() >= until)
            this.note(terminalId, `ring ${nonce}: paste not accepted: ${checked.reason}`)
          // Accepted twice running on the same screen, so it isn't caught mid-draw.
          if (accepted && landed === text) {
            acceptedTwice = true
            this.note(terminalId, `ring ${nonce}: paste accepted, Enter`)
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
    } catch (error) {
      // A throw (the screen's) fails the ring as any other end does: the nonce no longer
      // blocks prompts and answers, and the resizes go on.
      hold.settle()
      this.failed(terminalId, nonce)
      throw error
    } finally {
      hold.release()
    }
    if (!pressed) {
      hold.settle()
      this.failed(terminalId, nonce, true, acceptedTwice)
      return
    }
    this.confirming(terminalId, nonce, hold.settle)
  }

  /**
   * Watches the terminal's screen for `watchMs` and returns the rows that tick by
   * themselves; undefined when some other row changed meanwhile, or the terminal is gone.
   */
  private async watch(terminalId: string): Promise<ReadonlySet<number> | undefined> {
    const began = this.now()
    const until = began + this.watchMs
    while (this.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(Math.min(this.pollMs, Math.max(until - this.now(), 1)))
      // eslint-disable-next-line no-await-in-loop -- As above.
      const screen = await this.host.screen(terminalId)
      if (!screen) return undefined
      this.observe(terminalId, screen.rows, this.now())
    }
    const ticking = this.ticking(terminalId, this.now())
    const changes = this.seen.get(terminalId)?.changes ?? new Map<number, number[]>()
    for (const [at, times] of changes)
      if (!ticking.has(at) && times.some((time) => time >= began)) return undefined
    return ticking
  }

  /**
   * Submits, in its turn, the doorbell line a failed ring left in the box, which is
   * Novadeck's own (messaging says the person typed nothing since): Enter alone, under the
   * same gate as a ring, once the screen still shows exactly that line and nothing else
   * in the box, and while the hold is in force; then a wait for its doorbell prompt, which
   * carries the line's own nonce.
   */
  private async submit(entry: InputEntry, terminalId: string, nonce: string): Promise<void> {
    if (this.closed) return
    // The gate again, as the entries before it may have changed the screen: it finds the
    // same line (`leftovers`), or it is not this path's any more.
    if ((await this.open(terminalId, true)) !== undefined) return
    if (this.leftovers.get(terminalId) !== nonce) return
    this.leftovers.delete(terminalId)
    const screen = await this.host.screen(terminalId)
    if (!screen || this.host.leftover(terminalId, screen) !== nonce) return
    if (!this.host.ringLeftover(terminalId, nonce)) return
    const hold = entry.hold({ inputMs: this.pasteMs + inputCapMs, sizeMs: sizeCapMs })
    let pressed = false
    try {
      pressed =
        hold.holding() &&
        this.host.ringing(terminalId) === nonce &&
        this.host.write(terminalId, "\r")
    } finally {
      hold.release()
    }
    if (!pressed) {
      hold.settle()
      this.failed(terminalId, nonce, true, true)
      return
    }
    this.confirming(terminalId, nonce, hold.settle)
  }

  /** The ring's Enter is pressed: its prompt confirms it, or it fails after `confirmMs`. */
  private confirming(terminalId: string, nonce: string, settle: () => void): void {
    this.note(terminalId, `ring ${nonce} pressed; confirmation due in ${this.confirmMs} ms`)
    // The app's resizes wait on until its prompt confirms the ring, or it fails, as one
    // landing as the turn starts crashed Codex (0.159.3).
    this.pressed.set(terminalId, { nonce, settle })
    const timer = setTimeout(() => {
      if (this.host.ringing(terminalId) === nonce) this.failed(terminalId, nonce, true, true)
      if (this.pressed.get(terminalId)?.nonce === nonce) this.settle(terminalId)
    }, this.confirmMs)
    timer.unref()
  }
}
