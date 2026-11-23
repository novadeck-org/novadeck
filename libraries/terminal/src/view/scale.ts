// How an observed terminal is drawn: at the size its pty has, scaled down to fit the frame it
// is in and never above 1:1, anchored at the frame's top left. Pure: it imports nothing.

export type Extent = { readonly width: number; readonly height: number }

// The factor that fits `natural` into `room`, at most 1; undefined while either has no extent
// (a hidden frame, a screen not yet measured), which leaves the drawing as it is.
export const scaleToFit = (natural: Extent, room: Extent): number | undefined => {
  if (!(natural.width > 0 && natural.height > 0 && room.width > 0 && room.height > 0)) {
    return undefined
  }
  return Math.min(1, room.width / natural.width, room.height / natural.height)
}
