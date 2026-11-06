import type { ScreenText } from "@novadeck/emulator/headless"
import type { BoxProfile } from "@novadeck/tui-input/box"

import { readSlice, type Resting, type SliceBounds, type SliceProfile } from "../slices.js"

/** A state of a recorded run: the keys that led to it and the screen they left. */
export type SliceStep = { readonly label: string; readonly screen: ScreenText }

/** A harness's `live-slice.probe.json` as `loadProbe` reads it: runs of screens, in order. */
export type SliceFixture = { readonly runs: { readonly [run: string]: readonly SliceStep[] } }

export type SliceReplayed = {
  readonly label: string
  readonly screen: ScreenText
  readonly bounds: SliceBounds | undefined
  /** The rows the slice spans, without the blanks that end each. */
  readonly rows: readonly string[]
  readonly secret: boolean
}

/** Replays a run as the runner reads it, the screen at rest kept from state to state. */
export const replaySlices = (
  steps: readonly SliceStep[],
  box: BoxProfile,
  profile: SliceProfile,
): readonly SliceReplayed[] => {
  let rest: Resting | undefined
  return steps.map(({ label, screen }) => {
    const { bounds, resting } = readSlice({
      screen,
      rest,
      box,
      profile,
      waiting: false,
      unread: false,
    })
    if (resting) rest = { rows: screen.rows }
    const rows = bounds ? screen.rows.slice(bounds.first, bounds.last + 1) : []
    return {
      label,
      screen,
      bounds,
      rows: rows.map((row) => row.trimEnd()),
      secret: profile.secret(rows),
    }
  })
}
