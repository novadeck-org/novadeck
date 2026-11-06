import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"

import { isEmpty, showsTail, type BoxProfile, type InputBox } from "./box/box.js"
import { sameText } from "./box/text.js"
import type { InputEntry } from "./queue.js"

/** The waits of an interrupt, in milliseconds. */
export type InterruptOptions = {
  /** How long it looks for the turn's prompt put back in the program's box. */
  readonly restoreMs?: number
  /** How long the screen must be still without it before it is taken as not coming. */
  readonly restoreCalmMs?: number
  /**
   * How long after an interrupt the next one of the terminal waits before it looks at the
   * turn: the host may still report the turn working a moment after Escape ended it, and
   * a second Escape then would stop nothing.
   */
  readonly settleMs?: number
  /**
   * How long, once Escape stopped a turn with messages queued behind it, it waits for the
   * turn the program starts with them, which the second Escape stops.
   */
  readonly queuedTurnMs?: number
  /**
   * How long, before its first Escape, it waits for queued messages to get through what the
   * program runs as they are queued (`BoxProfile.queueing`).
   */
  readonly queueingMs?: number
}

/** What interrupts need of the terminal and its owner, by terminal. */
export type InterruptHost = {
  /**
   * Throws whatever refuses keys to the terminal's program now (the terminal is gone, no
   * program is there to take them, or one waits on the person's answer, whose dialog would
   * take them), and the interrupt lets it through as it is.
   */
  readonly admit: (terminalId: string) => void
  /** Whether the terminal is running and its program's turn is working. */
  readonly working: (terminalId: string) => boolean
  /** Whether the terminal is still running. */
  readonly alive: (terminalId: string) => boolean
  /** How the box of the program reads; undefined where none is known. */
  readonly profile: (terminalId: string) => BoxProfile | undefined
  /** The turn's prompt as the host knows it; undefined where it does not. */
  readonly prompt: (terminalId: string) => string | undefined
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: (terminalId: string) => Promise<ScreenText | undefined>
  /**
   * Writes keys to the program as the person's, through the bookkeeping their own keys get;
   * false once the terminal is gone.
   */
  readonly type: (terminalId: string, data: string) => boolean
  /** Writes keys to the terminal as they are, with none of that bookkeeping; false once it is gone. */
  readonly write: (terminalId: string, data: string) => boolean
}

/**
 * What an interrupt gave back: the words that were queued, or typed and not yet sent, which
 * clearing the box returned to the caller; undefined where there were none.
 */
export type InterruptOutcome = { readonly returned: string | undefined }

/**
 * An interrupt stopped the turn but left text in the box that clearing would lose or could
 * not clear: the person's to clear.
 */
export class BoxNotCleared extends Error {
  constructor() {
    super("The turn is stopped, but the box holds text that was not cleared.")
    this.name = "BoxNotCleared"
  }
}

/** How often the screen is looked at while an interrupt waits on it, in milliseconds. */
const pollMs = 50

/**
 * A screen as one string, to tell whether it has changed, as its profile's calm reads it
 * (`BoxProfile.still`): without what the program counts up by itself, as background agents'
 * elapsed time, which is no sign of keys taken.
 */
const rowsOf = (profile: BoxProfile, screen: ScreenText | undefined): string =>
  screen ? (profile.still?.(screen.rows) ?? screen.rows).join("\n") : ""

/**
 * Stops programs' turns as a person's Escape does, and leaves their boxes as they were. The
 * caller runs each in the terminal's input queue. Throws a `BoxNotCleared` where text that
 * is not the turn's own stays in the box.
 */
export class Interrupts {
  /** When each terminal's latest interrupt has settled, while it has not, in epoch milliseconds. */
  private readonly settles = new Map<string, number>()
  private readonly restoreMs: number
  private readonly restoreCalmMs: number
  private readonly settleMs: number
  private readonly queuedTurnMs: number
  private readonly queueingMs: number

  constructor(
    private readonly host: InterruptHost,
    options: InterruptOptions = {},
  ) {
    this.restoreMs = options.restoreMs ?? 2_000
    this.restoreCalmMs = options.restoreCalmMs ?? 500
    this.settleMs = options.settleMs ?? 1_000
    this.queuedTurnMs = options.queuedTurnMs ?? 3_000
    // Messages' hooks overlap, so this is a slow hook's time however many are queued
    // (probed 2026-11-06, a hook 1.3 s slow): one on Windows CI took about 1.25 s to start.
    this.queueingMs = options.queueingMs ?? 5_000
  }

  /**
   * Interrupts the terminal's program after the settle wait of the interrupt before it,
   * which the host may not have caught up with yet. `entry`, the interrupt's turn in the
   * terminal's input queue, holds the person's keys while the box is cleared, so none typed
   * then is cleared with it; without it they are not held.
   */
  async interrupt(terminalId: string, entry?: InputEntry): Promise<InterruptOutcome> {
    const settling = (this.settles.get(terminalId) ?? 0) - Date.now()
    if (settling > 0) await sleep(settling)
    // Only an Escape written calls for the wait: one that stopped nothing leaves nothing to settle.
    let escaped = false
    try {
      return await this.once(terminalId, entry, () => (escaped = true))
    } finally {
      if (escaped) {
        const until = Date.now() + this.settleMs
        this.settles.set(terminalId, until)
        setTimeout(() => {
          if (this.settles.get(terminalId) === until) this.settles.delete(terminalId)
        }, this.settleMs).unref()
      }
    }
  }

  private async once(
    terminalId: string,
    entry: InputEntry | undefined,
    escaped: () => void,
  ): Promise<InterruptOutcome> {
    const { host } = this
    const none = { returned: undefined }
    host.admit(terminalId)
    if (!host.working(terminalId)) return none
    // How its box reads, and the keys that clear it, if its program puts text back.
    const profile = host.profile(terminalId)
    // The turn's prompt, as the host knew it, ends with the turn Escape ends.
    const prompt = host.prompt(terminalId)
    // Only an empty box has text put back alone: text the person has typed there would be
    // merged with it, and is theirs.
    const first = profile && (await this.queuedIn(terminalId, profile))
    const boxBefore = first && profile?.read(first)
    const emptyBefore = boxBefore !== undefined && isEmpty(boxBefore)
    const queued = first !== undefined && profile?.queued(first) === true
    if (!host.working(terminalId)) return none
    host.type(terminalId, "\x1b")
    escaped()
    if (!profile || !emptyBefore) return none
    if (prompt === undefined && !queued) return none
    let box = await this.settled(terminalId, profile)
    // Programs send what was queued as the next turn, or a steer, which a second Escape
    // stops; some then put that message back in their box. One Escape does nothing at an idle
    // prompt, and two are never written here. That turn may start only after the box has
    // settled, as once the stopped turn took a busy machine longer to end (one program on
    // Windows CI: its queued turn began 0.8 s after the first Escape, and a second Escape
    // 0.6 s after it stopped nothing): it is waited for first.
    // Text the box holds by then, with no such turn, is the person's, typed meanwhile, as
    // nothing was put back yet: it is left as it is, as no second Escape goes over it.
    if (box !== undefined && isEmpty(box) && queued && host.alive(terminalId)) {
      const started = await this.turnStarts(terminalId)
      if (!started) {
        const screen = await host.screen(terminalId)
        const now = screen && profile.read(screen)
        if (now !== undefined && !isEmpty(now)) return none
      }
      host.type(terminalId, "\x1b")
      box = await this.settled(terminalId, profile)
    }
    if (!host.alive(terminalId)) return none
    // Text that may be there and can't be seen is left, and said.
    if (box === undefined && queued) throw new BoxNotCleared()
    if (box === undefined || isEmpty(box)) return none
    // The prompt put back is the turn's own, which the chat shows already; with messages
    // queued, what is there is theirs (the host names the queued one the person's latest).
    // A program puts it back as its text, never as a "[Pasted text]" placeholder, however
    // long (probed 2026-10-07); a prompt taller than its box shows only its tail, the box
    // then as tall as it gets.
    const rows = first?.rows.length ?? 0
    const restored =
      !queued &&
      prompt !== undefined &&
      (sameText(box.text, prompt) || showsTail(profile, box, rows, prompt))
    // Words given back in the box's shell mode are a shell command, `!` and all.
    const words = box.mode === "shell" ? `!${box.text.trim()}` : box.text.trim()
    // A placeholder stands for words that clearing would lose: they are left, and said.
    if (!profile.clear || (!restored && profile.collapsed(box))) throw new BoxNotCleared()
    if (!(await this.cleared(terminalId, profile, box, entry))) throw new BoxNotCleared()
    return restored ? none : { returned: words }
  }

  /**
   * The screen to stop the turn by: once messages queued behind it are through what the
   * program runs on them, or `queueingMs` has passed, as Escape would part them. An Escape
   * after the wait is let through as the first was. Undefined once the terminal is gone.
   */
  private async queuedIn(terminalId: string, profile: BoxProfile): Promise<ScreenText | undefined> {
    const { host } = this
    const queueing = (screen: ScreenText): boolean =>
      profile.queued(screen) && profile.queueing?.(screen) === true
    let screen = await host.screen(terminalId)
    if (!screen || !queueing(screen)) return screen
    const until = Date.now() + this.queueingMs
    while (screen && queueing(screen) && host.working(terminalId) && Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      screen = await host.screen(terminalId)
    }
    host.admit(terminalId)
    return screen
  }

  /**
   * Whether the terminal's program works again, on the turn it starts with what was queued,
   * within `queuedTurnMs`, which bounds how long this holds the terminal's input queue.
   * Nothing else ends the wait: the second Escape must come after that turn has started,
   * or it stops nothing. The queued messages leaving the screen says nothing either:
   * a program's Escape may send them at once as a steer, though the turn that runs them
   * came 1.4 s later on Windows CI.
   */
  private async turnStarts(terminalId: string): Promise<boolean> {
    const { host } = this
    const until = Date.now() + this.queuedTurnMs
    while (host.alive(terminalId) && Date.now() < until) {
      if (host.working(terminalId)) return true
      // eslint-disable-next-line no-await-in-loop -- Looks again until it works.
      await sleep(pollMs)
    }
    return host.working(terminalId)
  }

  /**
   * Clears the text of the box with the profile's keys, written, not typed (the box is
   * empty after them, which the person's keys never say), and looks that it reads empty,
   * writing them again up to twice if not, as the screen then calls for. False where it
   * does not. The person's keys are held (with `entry`) from the look the clear goes by to
   * its end, then go on into the box: a box that changed since `box` was read has their
   * keys in it, and is left as it is.
   */
  private async cleared(
    terminalId: string,
    profile: BoxProfile,
    box: InputBox,
    entry: InputEntry | undefined,
  ): Promise<boolean> {
    const { host } = this
    const capMs = 3 * this.restoreMs + 1_000
    const hold = entry?.hold({ inputMs: capMs, sizeMs: capMs })
    const holding = (): boolean => hold === undefined || hold.holding()
    try {
      // What the screen shows as each try is made: a profile's keys may need to follow what the
      // program has taken of the last (a second Escape, once its first has come).
      // Read twice under the hold, a poll apart, as a key the person typed just before it may
      // show only on the second.
      const unchanged = (screen: ScreenText | undefined): InputBox | undefined => {
        const shown = screen && profile.read(screen)
        return shown && shown.mode === box.mode && shown.text === box.text ? shown : undefined
      }
      if (!unchanged(await host.screen(terminalId))) return false
      await sleep(pollMs)
      let seen = await host.screen(terminalId)
      const shown = unchanged(seen)
      if (!shown || !holding()) return false
      let now = shown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!holding()) return false
        host.write(terminalId, profile.clear!(now, seen))
        // The same keys are written again only once the screen has changed since they were
        // (something of them was taken, and says what is left), or `restoreMs` has passed with
        // no change at all (they were lost): a program slow to take them, as one was on a busy
        // Windows machine, is not given a second pair over its first (the Escapes of the
        // second would open its rewind picker, seen in CI after 0.5 s of no change). What the
        // program counts up by itself is no change.
        const before = rowsOf(profile, seen)
        const wrote = Date.now()
        while (Date.now() < wrote + this.restoreMs) {
          // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
          await sleep(pollMs)
          // eslint-disable-next-line no-await-in-loop -- As above.
          const after = await host.screen(terminalId)
          const read = after && profile.read(after)
          if (!after || !host.alive(terminalId)) return false
          seen = after
          if (read !== undefined) {
            if (isEmpty(read)) return true
            now = read
          }
          if (Date.now() >= wrote + this.restoreCalmMs && rowsOf(profile, after) !== before) break
        }
      }
      return false
    } finally {
      hold?.settle()
    }
  }

  /**
   * The box once it has held still: steady on two reads running where it holds text, or
   * for `restoreCalmMs` where it is empty, the program putting something back in it
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
      await sleep(pollMs)
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
