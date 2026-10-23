// The shape of a team's wire on the rail's border (TeamWire.tsx), worked out from where the
// team's tabs sit. Everything is in one frame of reference, the workspace body's, in whole
// pixels, so the shape is plain numbers and can be tested alone.

// A member of the team as the sidebar lays it out: the middle of its name's line, and the
// left edge of its tab.
export type WireMember = { readonly id: string; readonly y: number; readonly left: number }

export type WireShape = {
  // The rail's border, the pixel column the wire runs down.
  readonly x: number
  // The wire's stretch: from the topmost member's row, running on into the list's edge where
  // one is out of view, down to the bottommost's, that row included, so the bottom tick
  // joins it.
  readonly top: number
  readonly height: number
  // The middle of the lead's name line, where the cursor sits, while the lead is in view.
  readonly lead: number | undefined
  // A tick into each worker in view. Each starts on the wire's own column, so its corner
  // overlaps the segment instead of meeting it edge to edge, which rounds to a seam at
  // fractional display scales, and reaches a little into the worker's tab.
  readonly taps: readonly { readonly id: string; readonly y: number; readonly width: number }[]
}

// How long the cursor blinks as a team lights: the lit wire's entrance ends with it. The
// stylesheets (team-wire.css, grid-team-wire.css, canvas.css) blink for as long.
export const blinkMs = 520

// How far a tick reaches into its worker's tab.
const reach = 3

// The wire for a team, or none while none of it can be drawn: every member out of view on
// one side, or the list's room too small to show it.
export const wireShape = (
  x: number,
  view: { readonly top: number; readonly bottom: number },
  lead: WireMember,
  workers: readonly WireMember[],
): WireShape | undefined => {
  const column = Math.round(x)
  const at = (member: WireMember) => ({
    ...member,
    y: Math.round(member.y),
    left: Math.round(member.left),
  })
  const head = at(lead)
  const crew = workers.map(at)
  const ys = [head, ...crew].map((member) => member.y)
  const edges = { top: Math.round(view.top), bottom: Math.round(view.bottom) }
  const top = Math.max(edges.top, Math.min(...ys))
  const bottom = Math.min(edges.bottom, Math.max(...ys))
  if (bottom <= top) return undefined
  const seen = (y: number) => y >= edges.top && y <= edges.bottom
  return {
    x: column,
    top,
    height: bottom - top + 1,
    lead: seen(head.y) ? head.y : undefined,
    taps: crew
      .filter((worker) => seen(worker.y))
      .map((worker) => ({
        id: worker.id,
        y: worker.y,
        width: Math.max(0, worker.left - column + reach),
      })),
  }
}
