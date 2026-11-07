import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"

import {
  fillsViewport,
  hidesText,
  isEmpty,
  newTurn,
  showsTail,
  takesQueue,
  type BoxProfile,
  type InputBox,
  type TurnStatus,
} from "./box/box.js"
import { sameText } from "./box/text.js"
import type { InputEntry, InputHold } from "./queue.js"

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

/** Words given back: in the box's shell mode they are a shell command, `!` and all. */
const wordsOf = ({ mode, text }: InputBox): string =>
  mode === "shell" ? `!${text.trim()}` : text.trim()

/** A hold on nothing, where no input queue's entry gave one: nothing waits on it. */
const inert: InputHold = {
  release: () => {},
  settle: () => {},
  settleAfter: () => {},
  holding: () => true,
  discard: () => {},
}

/**
 * Stops programs' turns as a person's Escape does, and leaves their boxes as they were. The
 * caller runs each in the terminal's input queue. Throws a `BoxNotCleared` where text that
 * is not the turn's own stays in the box, as words it can't be sure of having whole do.
 */
export class Interrupts {
  /** When each terminal's latest interrupt has settled, while it has not, in epoch milliseconds. */
  private readonly settles = new Map<string, number>()
  private readonly restoreMs: number
  private readonly restoreCalmMs: number
  private readonly settleMs: number
  private readonly queuedTurnMs: number

  constructor(
    private readonly host: InterruptHost,
    options: InterruptOptions = {},
  ) {
    this.restoreMs = options.restoreMs ?? 2_000
    this.restoreCalmMs = options.restoreCalmMs ?? 500
    this.settleMs = options.settleMs ?? 1_000
    this.queuedTurnMs = options.queuedTurnMs ?? 3_000
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
    let looked = profile ? await host.screen(terminalId) : undefined
    if (profile?.takeQueued && looked && takesQueue(profile, looked)) {
      const taking = await this.takeQueue(terminalId, profile, entry)
      if (taking.hold) return await this.takenBack(terminalId, profile, taking.hold, escaped)
      // Not taken: what follows goes by the screen as it is now.
      looked = taking.screen
    }
    const seen = looked
    const queuedBefore = seen !== undefined && profile?.queued(seen) === true
    const held = seen !== undefined && profile?.escapeHold?.holds(seen, prompt) === true
    const first = held ? await this.heldScreen(terminalId, profile!, seen, prompt) : seen
    // The turn's status row, before the Escape: a turn its queue starts is told from it.
    const stopped = first && profile?.status?.(first)
    const boxBefore = first && profile?.read(first)
    const emptyBefore = boxBefore !== undefined && isEmpty(boxBefore)
    const queuedNow = first !== undefined && profile?.queued(first) === true
    // A turn that ended during the hold had its queued messages behind it, which the program
    // may be sending by now with no word to the host: the Stop was for those too.
    const sending =
      held && (queuedBefore || queuedNow) && !host.working(terminalId) && host.alive(terminalId)
    const queued = queuedNow || sending
    if (!sending && !host.working(terminalId)) return none
    // What the box shows from now on is the program's: the person's keys wait, so text that
    // comes back only after the box has seemed settled is told from what they typed.
    const budget = this.restoreMs + this.queuedTurnMs + this.clearCapMs()
    const waiting =
      profile?.takeQueued && emptyBefore && queued
        ? entry?.hold({ inputMs: budget, sizeMs: budget })
        : undefined
    try {
      host.type(terminalId, "\x1b")
      escaped()
      if (!profile || !emptyBefore) return none
      if (prompt === undefined && !queued) return none
      let box = await this.settled(terminalId, profile)
      // Programs send what was queued as the next turn, or a steer, which a second Escape
      // stops; some then put that message back in their box. One Escape does nothing at an idle
      // prompt, and two are never written here so close together that they open a picker. That turn may start only after the box has
      // settled, as once the stopped turn took a busy machine longer to end (one program on
      // Windows CI: its queued turn began 0.8 s after the first Escape, and a second Escape
      // 0.6 s after it stopped nothing): it is waited for first.
      // Text the box holds by then, with no such turn, is the person's, typed meanwhile, as
      // nothing was put back yet: it is left as it is, as no second Escape goes over it.
      if (box !== undefined && isEmpty(box) && queued && host.alive(terminalId)) {
        const started = await this.turnStarts(terminalId, stopped || undefined)
        const screen = started ? undefined : await host.screen(terminalId)
        const now = screen && profile.read(screen)
        if (now !== undefined && !isEmpty(now)) {
          // Held from before the Escape, it isn't theirs: what was queued, come back late.
          if (!waiting?.holding()) return none
          box = now
        } else {
          host.type(terminalId, "\x1b")
          box = await this.settled(terminalId, profile)
        }
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
      // A placeholder stands for words that clearing would lose: they are left, and said. So
      // does a box that may hold more than it shows, where those words aren't known in full.
      if (!profile.clear) throw new BoxNotCleared()
      if (!restored && (profile.collapsed(box) || profile.stands(box.text)))
        throw new BoxNotCleared()
      if (!restored && profile.cut?.(box) === true) throw new BoxNotCleared()
      if (queued && fillsViewport(profile, box, rows)) throw new BoxNotCleared()
      const gone = await this.cleared(terminalId, profile, box, entry, waiting)
      if (gone === undefined) throw new BoxNotCleared()
      return restored ? none : { returned: wordsOf(gone) }
    } finally {
      waiting?.settle()
    }
  }

  /**
   * Takes what is queued behind the turn into the box, the person's input held from a look at
   * the screen to the end of the interrupt. Gives that hold where the box has it; otherwise
   * the screen as it is, the hold let go, for an interrupt to go on as if nothing was taken:
   * where the screen changed first, the keys took nothing in time, or found no queue, which
   * they leave again.
   */
  private async takeQueue(
    terminalId: string,
    profile: BoxProfile,
    entry: InputEntry | undefined,
  ): Promise<{ readonly hold?: InputHold; readonly screen: ScreenText | undefined }> {
    const { host } = this
    const { keys, recalled, leave } = profile.takeQueued!
    // As long as the keys may take, and then all a clear may.
    const budget = 2 * this.restoreMs + this.clearCapMs()
    const hold = entry?.hold({ inputMs: budget, sizeMs: budget })
    const holding = (): boolean => hold === undefined || hold.holding()
    // Read twice under the hold, a poll apart, as a key the person typed just before it may
    // show only on the second.
    await host.screen(terminalId)
    await sleep(pollMs)
    let screen = await host.screen(terminalId)
    if (!screen || !holding() || !takesQueue(profile, screen)) {
      hold?.settle()
      return { screen }
    }
    try {
      host.admit(terminalId)
    } catch (error) {
      hold?.settle()
      throw error
    }
    host.write(terminalId, keys)
    const until = Date.now() + this.restoreMs
    while (Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      screen = await host.screen(terminalId)
      if (!screen || !holding()) break
      if (recalled(screen)) {
        host.write(terminalId, leave)
        // eslint-disable-next-line no-await-in-loop -- It ends the loop.
        await sleep(pollMs)
        break
      }
      const box = profile.read(screen)
      if (box !== undefined && !isEmpty(box)) return { hold: hold ?? inert, screen }
    }
    hold?.settle()
    // What the hold let go is on its way to the box: the look at it mustn't miss that, or the
    // words go for what was queued.
    await sleep(2 * pollMs)
    return { screen: await host.screen(terminalId) }
  }

  /**
   * Stops the turn with what was queued in the box, where nothing can drain it, and gives
   * those words back. A turn that ended meanwhile needs no Escape.
   */
  private async takenBack(
    terminalId: string,
    profile: BoxProfile,
    hold: InputHold,
    escaped: () => void,
  ): Promise<InterruptOutcome> {
    const { host } = this
    try {
      if (host.working(terminalId)) {
        host.admit(terminalId)
        host.type(terminalId, "\x1b")
        escaped()
      }
      const box = await this.settled(terminalId, profile)
      if (!host.alive(terminalId)) return { returned: undefined }
      if (box === undefined) throw new BoxNotCleared()
      if (isEmpty(box)) return { returned: undefined }
      const rows = (await host.screen(terminalId))?.rows.length ?? 0
      // Words it can't give back whole stay in the box, and are said.
      const erase = box.mode === "shell" ? profile.shell.leave : profile.erase
      if (
        !erase ||
        profile.collapsed(box) ||
        profile.stands(box.text) ||
        hidesText(profile, box, rows)
      )
        throw new BoxNotCleared()
      // Not its clear keys, which may be Escapes: text in the box before the Escape, nothing says
      // that Escape was taken, and a program slow to take it opens its rewind picker on a pair
      // more. These keys stop nothing and open nothing, whenever they land.
      const gone = await this.cleared(terminalId, profile, box, undefined, hold, erase)
      if (gone === undefined) throw new BoxNotCleared()
      return { returned: wordsOf(gone) }
    } finally {
      hold.settle()
    }
  }

  /** How long clearing the box may hold the person's input. */
  private clearCapMs(): number {
    return 3 * this.restoreMs + 1_000
  }

  /**
   * The screen to stop the turn by, from `screen`, which the profile's `escapeHold` holds:
   * once it no longer does, or its time has passed. The Escape is let through again, as a
   * dialog may have come up meanwhile. Undefined once the terminal is gone.
   */
  private async heldScreen(
    terminalId: string,
    profile: BoxProfile,
    screen: ScreenText,
    prompt: string | undefined,
  ): Promise<ScreenText | undefined> {
    const { host } = this
    const { holds, ms } = profile.escapeHold!
    const until = Date.now() + ms
    let now: ScreenText | undefined = screen
    while (now && holds(now, prompt) && host.working(terminalId) && Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(pollMs)
      // eslint-disable-next-line no-await-in-loop -- As above.
      now = await host.screen(terminalId)
    }
    host.admit(terminalId)
    return now
  }

  /**
   * Whether the terminal's program works again, on the turn it starts with what was queued,
   * within `queuedTurnMs`, which bounds how long this holds the terminal's input queue.
   * Nothing else ends the wait: the second Escape must come after that turn has started,
   * or it stops nothing. The queued messages leaving the screen says nothing either:
   * a program's Escape may send them at once as a steer, though the turn that runs them
   * came 1.4 s later on Windows CI.
   */
  private async turnStarts(terminalId: string, stopped?: TurnStatus): Promise<boolean> {
    const { host } = this
    const until = Date.now() + this.queuedTurnMs
    // Where the program's queue starts its turn with no hook, its screen says so first.
    const status = host.profile(terminalId)?.status
    let before = stopped
    while (host.alive(terminalId) && Date.now() < until) {
      if (host.working(terminalId)) return true
      if (status) {
        // eslint-disable-next-line no-await-in-loop -- Looks again until it works.
        const screen = await host.screen(terminalId)
        const now = screen && status(screen)
        if (newTurn(before, now)) return true
        if (now?.ending) before = now
      }
      // eslint-disable-next-line no-await-in-loop -- As above.
      await sleep(pollMs)
    }
    return host.working(terminalId)
  }

  /**
   * Clears the text of the box with the profile's keys, written, not typed (the box is
   * empty after them, which the person's keys never say), and looks that it reads empty,
   * writing them again up to twice if not, as the screen then calls for. Returns what it
   * cleared: `box`, or more where the keys themselves brought more back (an Escape that
   * stops a turn a queued message had started puts that message under what is there, seen
   * on Windows CI, and the next clears both); undefined where the box doesn't read empty.
   * The person's keys are held (with `entry`) from the look the clear goes by to its end,
   * then go on into the box: a box that changed since `box` was read has their keys in it,
   * and is left as it is.
   */
  private async cleared(
    terminalId: string,
    profile: BoxProfile,
    box: InputBox,
    entry: InputEntry | undefined,
    held?: InputHold,
    keys: (box: InputBox, screen?: ScreenText) => string = profile.clear!,
  ): Promise<InputBox | undefined> {
    const { host } = this
    const capMs = this.clearCapMs()
    const hold = held ?? entry?.hold({ inputMs: capMs, sizeMs: capMs })
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
      if (!unchanged(await host.screen(terminalId))) return undefined
      await sleep(pollMs)
      let seen = await host.screen(terminalId)
      const shown = unchanged(seen)
      if (!shown || !holding()) return undefined
      let now = shown
      let gone = shown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!holding()) return undefined
        host.write(terminalId, keys(now, seen))
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
          if (!after || !host.alive(terminalId)) return undefined
          seen = after
          if (read !== undefined) {
            if (isEmpty(read)) return gone
            now = read
            if (read.mode === gone.mode && read.text.startsWith(gone.text)) gone = read
          }
          if (Date.now() >= wrote + this.restoreCalmMs && rowsOf(profile, after) !== before) break
        }
      }
      return undefined
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
