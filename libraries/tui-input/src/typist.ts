import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"

import { changedRows, checkPaste, isEmpty, type BoxProfile } from "./box.js"
import type { InputEntry } from "./queue.js"
import { bracketedPaste, calmMs, freshNonce, gate } from "./typing.js"

/** What the typist needs of one live terminal. */
export type TypingTarget = {
  /** Writes to the terminal; false once it is gone. */
  readonly type: (data: string) => boolean
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: () => Promise<ScreenText | undefined>
  /** When its window was last resized, in epoch milliseconds; 0 before any resize. */
  readonly resizedAt: number
  /** Whether the program typed to holds the foreground; undefined where that can't be told. */
  readonly holdsForeground: () => Promise<boolean | undefined>
}

/** Every duration the typist uses, in milliseconds. */
export type Timing = {
  readonly now: () => number
  /** How often the screen is looked at after the test paste. */
  readonly pollMs: number
  /** How long the test paste may take to show. */
  readonly pasteMs: number
  /**
   * How long the screen is watched before the test paste for rows that change by
   * themselves (a clock, a timer, a subagent's output).
   */
  readonly watchMs: number
  /** How long a row's changes count towards its ticking. */
  readonly tickWindowMs: number
  /** How long a screen must be still before anything is typed. */
  readonly calmMs: number
  /** How much longer than its test paste a delivery holds the person's input. */
  readonly inputCapMs: number
  /** The longest a delivery holds the app's resizes. */
  readonly sizeCapMs: number
}

/** Where the typist tells what it decided, line by line. */
export type Trace = (line: string) => void

/**
 * How long the test paste may take to show by default on `platform`, in milliseconds. A loaded
 * Windows runner stalls the runner for a second at a time (probed on CI), so the screen is
 * looked at less often than the test paste's check needs: more time there.
 */
export const pasteMsOn = (platform: NodeJS.Platform): number =>
  platform === "win32" ? 4_000 : 1_500

// How much longer than its test paste a delivery holds the person's input, in milliseconds: a
// safety cap, with room for the last looks and the Enter.
export const inputCapMs = 1_500

/**
 * The longest a delivery holds the app's resizes by default, in milliseconds: the caller's
 * backstop for a hold it never settles, which a caller that waits longer than this for the
 * program to confirm the line sets beyond its wait (`Timing.sizeCapMs`).
 */
export const sizeCapMs = 8_000

/** A look at the screen, with how long it has been still. */
export type Look = {
  readonly screen: ScreenText
  /** When the screen was read. */
  readonly at: number
  /** How long the screen has been still, a resize counting as a change, in milliseconds. */
  readonly calmFor: number
  /** When that calm began. */
  readonly calmSince: number
  /** Whether it has lasted the calm period. */
  readonly calm: boolean
}

/** Why typing is open, or not. */
export type Readiness =
  | "open"
  | "restless"
  | "no-bracketed-paste"
  | "not-foreground"
  | "no-input-box"
  | "vetoed"

/** Why a delivery that was begun did not end with its Enter pressed. */
export type DeliveryFailure =
  /** The input box showed text, or something else in its place, as the delivery began. */
  | "no-input-box"
  /** The terminal went. */
  | "gone"
  /** The line did not show alone in the box, twice running, in time. */
  | "not-landed"
  /** The line landed, but the hold lapsed, the delivery was superseded or the write failed. */
  | "not-pressed"

/** Enter was pressed; `settle` lets the app's resizes go, when the caller is done waiting. */
export type Entered = {
  readonly entered: true
  readonly nonce: string
  readonly settle: () => void
}

/** The delivery began and failed. `ours`: the line, if it landed, is alone in the box. */
export type DeliveryFailed = {
  readonly entered: false
  readonly started: true
  readonly nonce: string
  readonly reason: DeliveryFailure
  readonly ours: boolean
  /** Whether the failure counts: not when nothing was pasted. */
  readonly counted: boolean
}

/** Nothing was begun, and nothing typed: the screen is not calm after all, a resize came, or `start` said no. */
export type NotBegun = {
  readonly entered: false
  readonly started: false
  readonly reason: "restless" | "resized" | "declined"
}

export type Delivered = Entered | DeliveryFailed | NotBegun

/** How the box check is done: a profile reading the screen, or the caller's own answer. */
export type InputBoxCheck = (screen: ScreenText) => boolean | undefined

export type Typist = {
  /**
   * Reads the screen, observes its rows and measures the calm; undefined once the terminal is
   * gone.
   */
  readonly look: () => Promise<Look | undefined>
  /**
   * The gate on a look: bracketed paste, foreground, input box, and the caller's `veto`, which
   * says true when typing must not go on.
   */
  readonly ready: (look: Look, veto?: () => boolean) => Promise<Readiness>
  /**
   * Pastes the line `line(nonce)` as a test, in the entry's turn, with the person's input held
   * until its Enter, and presses Enter only once the line shows alone, twice running, and while the
   * hold is still in force and `still(nonce)`. `start` is asked just before the hold, with the
   * nonce: false ends it untried. `vanish`, asked after the screen was watched, says whether a
   * block of text may vanish as the line lands. A hold is settled on failure, and on a throw
   * (the screen's), which passes on.
   */
  readonly deliver: (
    entry: InputEntry,
    line: (nonce: string) => string,
    options: {
      readonly vanish?: () => boolean
      /** When the calm that led here began: a resize after it puts the delivery off. */
      readonly calmSince: number
      readonly start: (nonce: string) => boolean
      readonly still: (nonce: string) => boolean
    },
  ) => Promise<Delivered>
  /** Enter alone, for a line left by a failed delivery, while the hold is in force and `still`. */
  readonly submit: (
    entry: InputEntry,
    nonce: string,
    still: (nonce: string) => boolean,
  ) => Promise<Entered | DeliveryFailed>
  /** Drops what it saw of the terminal, which is gone. */
  readonly forget: () => void
}

/** Types into `target`: the mechanics of ringing an idle program, without any of when to. */
export const createTypist = (
  target: TypingTarget,
  options: {
    /** How the program draws its input box, or the caller's own reading of it. */
    readonly profile: BoxProfile | InputBoxCheck
    /**
     * Whether the program's input box is looked at before and as a delivery begins (default
     * true); false only for a stand-in TUI that draws none.
     */
    readonly boxCheck?: boolean
    readonly timing?: Partial<Timing>
    readonly trace?: Trace
  },
): Typist => {
  const timing: Timing = {
    now: Date.now,
    pollMs: 50,
    pasteMs: pasteMsOn(process.platform),
    watchMs: 1_100,
    tickWindowMs: 10_000,
    calmMs,
    inputCapMs,
    sizeCapMs,
    ...options.timing,
  }
  const { now, pollMs, pasteMs, watchMs, tickWindowMs } = timing
  const boxCheck = options.boxCheck ?? true
  const trace = options.trace ?? (() => {})
  const { profile } = options
  const check: InputBoxCheck =
    typeof profile === "function"
      ? profile
      : (screen) => {
          const box = profile.read(screen)
          return (
            box !== undefined &&
            box.mode === "prompt" &&
            isEmpty(box) &&
            profile.overlay(screen) === false
          )
        }

  /** The rows of the screen as last seen, and when each row changed, lately. */
  let seen: { rows: readonly string[]; changes: Map<number, number[]> } | undefined
  /** The screen's text as last seen, and since when. */
  let still: { text: string; since: number } | undefined

  /** Notes which rows of the screen changed since it was last seen. */
  const observe = (rows: readonly string[], at: number): void => {
    const changes = seen?.changes ?? new Map<number, number[]>()
    if (seen)
      for (const row of changedRows(seen.rows, rows))
        changes.set(row, [...(changes.get(row) ?? []), at])
    seen = { rows, changes }
  }

  /** The rows that changed at least twice lately, with nothing of ours to cause it: ticking. */
  const ticking = (at: number): ReadonlySet<number> => {
    const rows = new Set<number>()
    const changes = seen?.changes
    if (!changes) return rows
    for (const [row, times] of changes) {
      const lately = times.filter((time) => at - time <= tickWindowMs)
      if (lately.length === 0) changes.delete(row)
      else changes.set(row, lately)
      if (lately.length >= 2) rows.add(row)
    }
    return rows
  }

  /**
   * Watches the screen for `watchMs` and returns the rows that tick by themselves;
   * undefined when some other row changed meanwhile, or the terminal is gone.
   */
  const watch = async (): Promise<ReadonlySet<number> | undefined> => {
    const began = now()
    const until = began + watchMs
    while (now() < until) {
      // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
      await sleep(Math.min(pollMs, Math.max(until - now(), 1)))
      // eslint-disable-next-line no-await-in-loop -- As above.
      const screen = await target.screen()
      if (!screen) return undefined
      observe(screen.rows, now())
    }
    const rows = ticking(now())
    const changes = seen?.changes ?? new Map<number, number[]>()
    for (const [row, times] of changes)
      if (!rows.has(row) && times.some((time) => time >= began)) return undefined
    return rows
  }

  const look = async (): Promise<Look | undefined> => {
    const screen = await target.screen()
    if (!screen) return undefined
    const at = now()
    observe(screen.rows, at)
    const text = screen.rows.join("\n")
    const calmSince = still?.text === text ? still.since : at
    still = { text, since: calmSince }
    // A resize ends the calm too: the TUI may not have redrawn for it yet.
    const calmFor = at - Math.max(calmSince, target.resizedAt)
    return { screen, at, calmFor, calmSince: at - calmFor, calm: calmFor >= timing.calmMs }
  }

  const ready = async (looked: Look, veto?: () => boolean): Promise<Readiness> => {
    const { screen } = looked
    const foreground = await target.holdsForeground()
    const inputBox = boxCheck ? check(screen) : undefined
    const verdict = gate(
      {
        ringable: !veto?.(),
        calmMs: looked.calmFor,
        bracketedPaste: screen.bracketedPaste,
        foreground,
        ...(inputBox !== undefined && { inputBox }),
      },
      timing.calmMs,
    )
    trace(
      `gate ${verdict} (foreground ${String(foreground)}, input box ${String(inputBox)}, bracketed paste ${screen.bracketedPaste})`,
    )
    return verdict === "not-ringable" ? "vetoed" : verdict
  }

  const deliver: Typist["deliver"] = async (entry, line, o) => {
    // Watch the screen for rows that change by themselves, which the paste's check then
    // lets be. A change in any other row means the screen is not calm after all.
    const rows = await watch()
    if (rows === undefined) return { entered: false, started: false, reason: "restless" }
    const nonce = freshNonce()
    const text = line(nonce)
    trace(`ring ${nonce} begins (ticking rows ${[...rows].join(",") || "none"})`)
    // Whether a block of text may vanish as the line lands, as a program's first screen may
    // clear its banner: the caller says when.
    const vanish = o.vanish?.() ?? false
    if (target.resizedAt > o.calmSince) return { entered: false, started: false, reason: "resized" }
    if (!o.start(nonce)) return { entered: false, started: false, reason: "declined" }
    const hold = entry.hold({ inputMs: pasteMs + timing.inputCapMs, sizeMs: timing.sizeCapMs })
    let pressed = false
    let reason: DeliveryFailure = "gone"
    // Whether the paste check accepted the line: then it is alone in the agent's box.
    let acceptedTwice = false
    try {
      const before = await target.screen()
      // The box is looked at again now, on every platform: a key of the person's or a view
      // since the calm may have left text in it or something else in its place.
      if (before && boxCheck && check(before) === false) {
        hold.settle()
        return {
          entered: false,
          started: true,
          nonce,
          reason: "no-input-box",
          ours: false,
          counted: false,
        }
      }
      if (before && target.type(bracketedPaste(text))) {
        reason = "not-landed"
        const until = now() + pasteMs
        let landed: string | undefined
        while (o.still(nonce)) {
          // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
          await sleep(pollMs)
          // eslint-disable-next-line no-await-in-loop -- As above.
          const after = await target.screen()
          if (!after) {
            reason = "gone"
            break
          }
          const shown = after.rows.join("\n")
          const checked = checkPaste(before.rows, after.rows, text, { vanish, ticking: rows })
          const accepted = checked.accepted
          if (!accepted && now() >= until)
            trace(`ring ${nonce}: paste not accepted: ${checked.reason}`)
          // Accepted twice running on the same screen, so it isn't caught mid-draw.
          if (accepted && landed === shown) {
            acceptedTwice = true
            trace(`ring ${nonce}: paste accepted, Enter`)
            pressed = hold.holding() && o.still(nonce) && target.type("\r")
            reason = "not-pressed"
            break
          }
          landed = accepted ? shown : undefined
          if (now() >= until) break
        }
      }
    } catch (error) {
      // A throw (the screen's) ends the delivery as any other end does: the resizes go on.
      hold.settle()
      throw error
    } finally {
      hold.release()
    }
    if (!pressed) {
      hold.settle()
      return {
        entered: false,
        started: true,
        nonce,
        reason,
        ours: acceptedTwice,
        counted: true,
      }
    }
    return { entered: true, nonce, settle: hold.settle }
  }

  const submit: Typist["submit"] = async (entry, nonce, again) => {
    const hold = entry.hold({ inputMs: pasteMs + timing.inputCapMs, sizeMs: timing.sizeCapMs })
    let pressed = false
    try {
      pressed = hold.holding() && again(nonce) && target.type("\r")
    } finally {
      hold.release()
    }
    if (!pressed) {
      hold.settle()
      return {
        entered: false,
        started: true,
        nonce,
        reason: "not-pressed",
        ours: true,
        counted: true,
      }
    }
    return { entered: true, nonce, settle: hold.settle }
  }

  return {
    look,
    ready,
    deliver,
    submit,
    forget: () => {
      seen = undefined
      still = undefined
    },
  }
}
