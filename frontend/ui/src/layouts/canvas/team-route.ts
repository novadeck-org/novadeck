// The route of the team wire on the canvas (CanvasTeamWire.tsx), worked out from where the
// team's windows sit. Everything is in the canvas's own (world) units, so the route is plain
// numbers and can be tested alone; the component turns it into pixels.
//
// The wire starts on the lead's edge at its header line and ends on each worker's edge at
// its header line, where the selection bar sits. Between them it runs at right angles only:
// out from the lead along its header line to a vertical trunk, along the trunk past every
// worker it serves, and along each worker's header line into its edge. The lead has at most
// one trunk on each side, so trunks never coincide or cross. A worker is served by where it
// is against the lead:
//   - right of the lead (its left edge is past the lead's right edge): the right trunk,
//     midway between the lead's right edge and the nearest such worker's left edge; ticks
//     enter left edges.
//   - left of the lead: the left trunk, the mirror, midway between the lead's left edge and
//     the nearest such worker's right edge; ticks enter right edges.
//   - above or below the lead, overlapping it horizontally ("stacked"): the left trunk, as
//     the sidebar's wire runs on the left, `stackGap` left of the leftmost edge of the lead
//     and those workers, so it never runs through the lead; ticks enter their left edges,
//     where the selection bar sits. Where workers left of the lead already have the left
//     trunk, the stacked workers get the right one, mirrored. Where both sides are taken,
//     they join the trunk on the side their middle is nearer to (the left on a tie), entering
//     the edge that faces it; the trunk moves out to `stackGap` clear of a stacked worker it
//     would otherwise run through.
// The lead's cursor shows outside each edge a trunk leaves from. Where a window sits over a
// run, the run goes behind it, as the canvas draws the wire beneath its windows.

export type Point = { readonly x: number; readonly y: number }
export type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}
export type Member = Rect & { readonly id: string }

// A straight run, horizontal or vertical.
export type Run = { readonly from: Point; readonly to: Point }

export type Side = "left" | "right"

export type TeamRoute = {
  // A trunk and what leaves the lead for it: the lead's edge where the cursor sits, the run
  // out to the trunk, and the trunk.
  readonly sides: readonly {
    readonly side: Side
    readonly cursor: Point
    readonly stem: Run
    readonly trunk: Run
  }[]
  // Into each worker, from its trunk to the worker's edge.
  readonly ticks: readonly { readonly id: string; readonly run: Run }[]
  // Each worker's way from the lead: its corners in order, and how long it is.
  readonly paths: readonly {
    readonly id: string
    readonly points: readonly Point[]
    readonly length: number
  }[]
}

type Into = { readonly id: string; readonly y: number; readonly x: number }
type Group = { readonly side: Side; edge: number; trunk: number; into: Into[] }

const run = (x1: number, y1: number, x2: number, y2: number): Run => ({
  from: { x: x1, y: y1 },
  to: { x: x2, y: y2 },
})
const length = (points: readonly Point[]) =>
  points.reduce(
    (sum, point, index) =>
      index
        ? sum + Math.abs(point.x - points[index - 1]!.x) + Math.abs(point.y - points[index - 1]!.y)
        : 0,
    0,
  )

// How far the trunk of a stacked worker stands clear of the windows.
export const stackGap = 32

// The route for `workers` around `lead`, whose header lines are `headerLine` below their
// tops, or none while there is no lead or no worker to draw it to.
export const teamRoute = (
  lead: Rect | undefined,
  workers: readonly Member[],
  headerLine: number,
): TeamRoute | undefined => {
  if (!lead || !workers.length) return undefined
  const line = (rect: Rect) => rect.y + headerLine
  const leadRight = lead.x + lead.width
  const right = workers.filter((worker) => worker.x >= leadRight)
  const left = workers.filter((worker) => worker.x + worker.width <= lead.x)
  const stack = workers.filter((worker) => !right.includes(worker) && !left.includes(worker))
  const into = (worker: Member, x: number): Into => ({ id: worker.id, y: line(worker), x })
  const groups: Group[] = []
  if (right.length)
    groups.push({
      side: "right",
      edge: leadRight,
      trunk: (leadRight + Math.min(...right.map((worker) => worker.x))) / 2,
      into: right.map((worker) => into(worker, worker.x)),
    })
  if (left.length)
    groups.push({
      side: "left",
      edge: lead.x,
      trunk: (lead.x + Math.max(...left.map((worker) => worker.x + worker.width))) / 2,
      into: left.map((worker) => into(worker, worker.x + worker.width)),
    })
  if (stack.length) {
    const middle =
      stack.reduce((sum, worker) => sum + worker.x + worker.width / 2, 0) / stack.length
    const taken = (side: Side) => groups.find((group) => group.side === side)
    const side: Side = !taken("left")
      ? "left"
      : !taken("right")
        ? "right"
        : middle <= lead.x + lead.width / 2
          ? "left"
          : "right"
    const sign = side === "left" ? -1 : 1
    // The edge of a stacked worker that faces its trunk.
    const facing = (worker: Member) => (side === "left" ? worker.x : worker.x + worker.width)
    const group = taken(side)
    if (group) {
      // Joins the trunk, which moves out of the way of a stacked worker it would run through.
      for (const worker of stack)
        if (group.trunk * sign <= facing(worker) * sign)
          group.trunk = facing(worker) + sign * stackGap
      group.into.push(...stack.map((worker) => into(worker, facing(worker))))
    } else {
      const edge = side === "left" ? lead.x : leadRight
      const outermost = sign * Math.max(...[edge, ...stack.map(facing)].map((x) => x * sign))
      groups.push({
        side,
        edge,
        trunk: outermost + sign * stackGap,
        into: stack.map((worker) => into(worker, facing(worker))),
      })
    }
  }
  const y = line(lead)
  return {
    sides: groups.map((group) => {
      const ys = group.into.map((worker) => worker.y)
      return {
        side: group.side,
        cursor: { x: group.edge, y },
        stem: run(group.edge, y, group.trunk, y),
        trunk: run(group.trunk, Math.min(y, ...ys), group.trunk, Math.max(y, ...ys)),
      }
    }),
    ticks: groups.flatMap((group) =>
      group.into.map((worker) => ({
        id: worker.id,
        run: run(group.trunk, worker.y, worker.x, worker.y),
      })),
    ),
    paths: groups.flatMap((group) =>
      group.into.map((worker) => {
        const points = [
          { x: group.edge, y },
          { x: group.trunk, y },
          { x: group.trunk, y: worker.y },
          { x: worker.x, y: worker.y },
        ]
        return { id: worker.id, points, length: length(points) }
      }),
    ),
  }
}
