// The shape of the wire that joins the selected terminal's team on the rail's border
// (TeamWire.tsx), worked out from where the team's tabs sit. Everything is in one frame of
// reference, the workspace body's, so the shape is plain numbers and can be tested alone.

// A member of the team as the sidebar lays it out: the middle of its name's line, and the
// left edge of its tab.
export type WireMember = { readonly id: string; readonly y: number; readonly left: number }

export type WireShape = {
  // The rail's border, which the wire lights.
  readonly x: number
  // The lit stretch: the topmost member to the bottommost, running on into the list's edge
  // where one is out of view.
  readonly top: number
  readonly bottom: number
  // The middle of the lead's name line, where the cursor sits, while the lead is in view.
  readonly lead: number | undefined
  // A tick from the wire into each worker in view, with when the pulse reaches it.
  readonly taps: readonly {
    readonly id: string
    readonly y: number
    readonly width: number
    readonly at: number
  }[]
  // The pulse that leaves the lead when the team is selected: how far it runs each way,
  // and for how long. Absent while the lead is out of view.
  readonly pulse:
    | { readonly up: number; readonly down: number; readonly duration: number }
    | undefined
}

// How long the cursor blinks before the pulse leaves it, and how long the pulse takes over
// the longest stretch it runs (a short team runs quicker, a tall one no slower than this).
export const blinkMs = 520
const pulseMs = (span: number) => Math.min(700, 260 + span * 0.8)

// The wire for a team, or none while none of it can be drawn: every member out of view on
// one side, or the list's room too small to show it.
export const wireShape = (
  x: number,
  view: { readonly top: number; readonly bottom: number },
  lead: WireMember,
  workers: readonly WireMember[],
): WireShape | undefined => {
  const members = [lead, ...workers]
  const ys = members.map((member) => member.y)
  const top = Math.max(view.top, Math.min(...ys))
  const bottom = Math.min(view.bottom, Math.max(...ys))
  if (bottom <= top) return undefined
  const seen = (y: number) => y >= view.top && y <= view.bottom
  const leadSeen = seen(lead.y)
  const span = Math.max(1, bottom - lead.y, lead.y - top)
  const duration = pulseMs(span)
  return {
    x,
    top,
    bottom,
    lead: leadSeen ? lead.y : undefined,
    taps: workers
      .filter((worker) => seen(worker.y))
      .map((worker) => ({
        id: worker.id,
        y: worker.y,
        width: Math.max(0, worker.left - x - 1),
        // The pulse reaches each tick in turn, after the cursor's blink.
        at: Math.round(blinkMs + (Math.abs(worker.y - lead.y) / span) * duration * 0.85),
      })),
    pulse: leadSeen ? { up: lead.y - top, down: bottom - lead.y, duration } : undefined,
  }
}
