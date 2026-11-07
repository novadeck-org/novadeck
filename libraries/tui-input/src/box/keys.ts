import { setTimeout as sleep } from "node:timers/promises"

import type { ScreenText } from "@novadeck/emulator/headless"

import type { BoxProfile, InputBox } from "./box.js"
import { hidesText } from "./box.js"
import { cursorAtEnd, toEnd } from "./leftover.js"
import { sameText } from "./text.js"

/** What pressing keys in a box needs of its terminal. */
export type BoxKeysHost = {
  /** Throws where keys may not go now, as a request waits. */
  readonly admit: () => void
  /** Writes keys as they are; false once the terminal is gone. */
  readonly write: (keys: string) => boolean
  /** The screen once it has drawn all pending output; undefined once the terminal is gone. */
  readonly screen: () => Promise<ScreenText | undefined>
  /** Whether the person's input is still held. */
  readonly holding: () => boolean
}

/** How long keys may take to show, and how often the screen is looked at, in milliseconds. */
export type BoxKeysTiming = { readonly pollMs: number; readonly keysMs: number }

/**
 * Writes the keys once and gives the screen `reached` holds of on two reads running, within
 * `keysMs`; undefined where it didn't, or the keys couldn't be written. It never presses them
 * again: a harness that changed ends in a refusal, not a run of keys into who knows what.
 */
export const pressKeys = async (
  host: BoxKeysHost,
  timing: BoxKeysTiming,
  keys: string,
  reached: (screen: ScreenText) => boolean,
): Promise<ScreenText | undefined> => {
  host.admit()
  if (!host.write(keys)) return undefined
  const until = Date.now() + timing.keysMs
  let seen = false
  while (Date.now() < until && host.holding()) {
    // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
    await sleep(timing.pollMs)
    // eslint-disable-next-line no-await-in-loop -- As above.
    const after = await host.screen()
    if (!after) return undefined
    const fits = reached(after)
    if (fits && seen) return after
    seen = fits
  }
  return undefined
}

/**
 * The screen with the cursor after what the box holds, seen so; undefined where it can't be.
 * A box that may show only a tail may hold the cursor in a part it scrolled to, whose last row
 * is no end of its text: no key is pressed to get there. On that last row's end the cursor can't
 * be told from one at the text's end.
 */
export const cursorEnded = async (
  host: BoxKeysHost,
  timing: BoxKeysTiming,
  profile: BoxProfile,
  box: InputBox,
  screen: ScreenText,
): Promise<ScreenText | undefined> => {
  if (cursorAtEnd(profile, box, screen)) return screen
  const keys = toEnd(box, screen)
  if (keys === undefined || hidesText(profile, box, screen.rows.length)) return undefined
  return await pressKeys(host, timing, keys, (after) => {
    const read = profile.read(after)
    return read !== undefined && sameText(read.text, box.text)
      ? cursorAtEnd(profile, read, after)
      : false
  })
}
