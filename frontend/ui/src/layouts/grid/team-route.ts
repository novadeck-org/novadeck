// The wires that join each team through the Grid's gutters
// (GridTeamWire.tsx), worked out from where the tiles sit. All in the grid container's
// frame in pixels, so the route is plain numbers and can be tested alone.

import type { GridItem } from "@novadeck/core/types"
import { calcGridItemPosition } from "react-grid-layout"

// A tile as the grid lays it out.
export type TileBox = {
  readonly id: string
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

// A straight run of the wire: one pixel thick, from (x, y) over `length` pixels.
export type Run = {
  readonly x: number
  readonly y: number
  readonly length: number
  readonly axis: "horizontal" | "vertical"
}

export type Point = readonly [x: number, y: number]

export type TeamRoute = {
  // Where the cursor sits: in the gutter left of the lead, on its header line.
  readonly cursor: Point
  // The runs through the gutters, joined end to end where routes share them.
  readonly runs: readonly Run[]
  // A tick from the gutter into each worker's left edge, and the route that reaches it
  // from the cursor, with how far that runs.
  readonly workers: readonly {
    readonly id: string
    readonly tick: Run
    readonly path: readonly Point[]
    readonly distance: number
  }[]
}

// The header's height in the Grid, whose middle is the line the wire meets a tile on.
const headerLine = 27

// What turning a corner costs in pixels of detour, and what a run another route already
// drew costs per pixel: little, so routes join into a trunk.
const bendCost = 40
const sharedCost = 0.05
// What a run another team's wire already takes costs per pixel: enough to go round it
// where there is room, not so much as to leave a team unreached.
const foreignCost = 4

// The pixel boxes of the grid's items, where react-grid-layout puts them (its own
// calculation, so edges that meet there meet here).
export const tileBoxes = (
  items: readonly GridItem[],
  width: number,
  columns: number,
  rowHeight: number,
  margin: number,
): TileBox[] => {
  const params = {
    cols: columns,
    containerPadding: [0, 0] as [number, number],
    containerWidth: width,
    margin: [margin, margin] as [number, number],
    maxRows: Infinity,
    rowHeight,
  }
  return items.map((item) => {
    const {
      left,
      top,
      width: w,
      height,
    } = calcGridItemPosition(params, item.x, item.y, item.w, item.h)
    return { id: item.i, left, top, width: w, height }
  })
}

type Edge = {
  readonly to: number
  readonly length: number
  readonly axis: 0 | 1
}

// A team as the route sees it.
type Crew = { readonly lead: string; readonly workers: readonly string[] }

// The wire of one team alone: see `teamRoutes`.
export const teamRoute = (
  boxes: readonly TileBox[],
  lead: string,
  workers: readonly string[],
  gap: number,
  width: number,
): TeamRoute | undefined => teamRoutes(boxes, [{ lead, workers }], gap, width)[0]

// The wire of each team from its lead to its workers through the gutters, in the order the
// teams come: none for a team whose lead or every worker is missing or can't be reached
// without crossing a tile. A worker that can't be reached has no tick, and the rest are
// drawn. Teams keep to runs of their own where the grid has room, so two can be told apart.
export const teamRoutes = (
  boxes: readonly TileBox[],
  teams: readonly Crew[],
  gap: number,
  width: number,
): (TeamRoute | undefined)[] => {
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const crews = teams.map(({ lead, workers }) => {
    const from = byId.get(lead)
    const members = workers.flatMap((id) => {
      const box = byId.get(id)
      return box && id !== lead ? [box] : []
    })
    return { from, members }
  })
  if (!crews.some((crew) => crew.from && crew.members.length)) return teams.map(() => undefined)
  const half = gap / 2

  // Lines through the middle of every gutter, and each member's header line.
  const xs = lines([
    -half,
    width + half,
    ...boxes.flatMap((box) => [box.left - half, box.left + box.width + half]),
  ])
  const ys = lines([
    -half,
    ...boxes.flatMap((box) => [box.top - half, box.top + box.height + half]),
    ...crews.flatMap(({ from, members }) =>
      from && members.length ? [from, ...members].map((box) => box.top + headerLine) : [],
    ),
  ])
  const free = (x1: number, y1: number, x2: number, y2: number) =>
    !boxes.some(
      (box) =>
        box.left < Math.max(x1, x2) &&
        Math.min(x1, x2) < box.left + box.width &&
        box.top < Math.max(y1, y2) &&
        Math.min(y1, y2) < box.top + box.height,
    )
  const node = (xi: number, yi: number) => xi * ys.length + yi
  const edges: Edge[][] = Array.from({ length: xs.length * ys.length }, () => [])
  const link = (a: number, b: number, length: number, axis: 0 | 1) => {
    edges[a]!.push({ to: b, length, axis })
    edges[b]!.push({ to: a, length, axis })
  }
  for (let xi = 0; xi < xs.length; xi++) {
    for (let yi = 0; yi < ys.length; yi++) {
      const x = xs[xi]!
      const y = ys[yi]!
      if (xi + 1 < xs.length && free(x, y, xs[xi + 1]!, y))
        link(node(xi, yi), node(xi + 1, yi), xs[xi + 1]! - x, 0)
      if (yi + 1 < ys.length && free(x, y, x, ys[yi + 1]!))
        link(node(xi, yi), node(xi, yi + 1), ys[yi + 1]! - y, 1)
    }
  }
  const portOf = (box: TileBox) =>
    node(xs.indexOf(box.left - half), ys.indexOf(box.top + headerLine))
  const point = (n: number): Point => [xs[Math.floor(n / ys.length)]!, ys[n % ys.length]!]

  // What earlier teams' wires run along.
  const taken = new Set<string>()
  return crews.map(({ from, members }) => {
    if (!from || !members.length) return undefined
    const used = new Set<string>()
    const start = portOf(from)

    // The cheapest route to `goal`: length, a penalty for each corner, next to nothing over
    // what an earlier route of this team used and a good deal over another team's. States
    // are a node and the axis it was reached along.
    const route = (goal: number): number[] | undefined => {
      const cost = new Map<number, number>()
      const before = new Map<number, number>()
      const queue = new Heap()
      const push = (at: number, state: number, previous: number) => {
        if (at >= (cost.get(state) ?? Infinity)) return
        cost.set(state, at)
        before.set(state, previous)
        queue.push(at, state)
      }
      push(0, start * 2, -1)
      push(0, start * 2 + 1, -1)
      while (queue.size) {
        const [at, state] = queue.pop()!
        if (at > (cost.get(state) ?? Infinity)) continue
        const here = state >> 1
        if (here === goal) {
          const path = [here]
          for (let step = before.get(state)!; step >= 0; step = before.get(step)!)
            path.push(step >> 1)
          return path.toReversed().filter((n, i, all) => n !== all[i - 1])
        }
        for (const edge of edges[here]!) {
          const edgeKey = key(here, edge.to)
          const rate = used.has(edgeKey) ? sharedCost : taken.has(edgeKey) ? foreignCost : 1
          const next = at + edge.length * rate
          push(next + (edge.axis === (state & 1) ? 0 : bendCost), edge.to * 2 + edge.axis, state)
        }
      }
      return undefined
    }

    // Nearest first, so the farther ones join the runs they leave.
    const reached = members
      .map((box) => ({ box, goal: portOf(box) }))
      .toSorted(
        (a, b) =>
          Math.abs(a.box.top - from.top) +
          Math.abs(a.box.left - from.left) -
          (Math.abs(b.box.top - from.top) + Math.abs(b.box.left - from.left)),
      )
      .flatMap(({ box, goal }) => {
        const path = route(goal)
        if (!path) return []
        path.forEach((n, i) => i && used.add(key(path[i - 1]!, n)))
        return [{ box, path: corners(path.map(point)) }]
      })
    if (!reached.length) return undefined
    for (const edge of used) taken.add(edge)

    const [cursorX, cursorY] = point(start)
    return {
      cursor: [cursorX, cursorY],
      runs: merged(used, point),
      workers: reached.map(({ box, path }) => ({
        id: box.id,
        tick: {
          x: box.left - half,
          y: box.top + headerLine,
          length: half,
          axis: "horizontal" as const,
        },
        path,
        distance: length(path),
      })),
    }
  })
}

// A queue that gives back its smallest cost first.
class Heap {
  private readonly items: [cost: number, state: number][] = []

  get size(): number {
    return this.items.length
  }

  push(cost: number, state: number): void {
    const items = this.items
    let at = items.push([cost, state]) - 1
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (items[parent]![0] <= cost) break
      ;[items[parent], items[at]] = [items[at]!, items[parent]!]
      at = parent
    }
  }

  pop(): [cost: number, state: number] | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (!top || !last) return top
    if (items.length) {
      items[0] = last
      let at = 0
      for (;;) {
        const left = at * 2 + 1
        const child =
          left + 1 < items.length && items[left + 1]![0] < items[left]![0] ? left + 1 : left
        if (child >= items.length || items[child]![0] >= last[0]) break
        ;[items[child], items[at]] = [items[at]!, items[child]!]
        at = child
      }
    }
    return top
  }
}

// The sorted, distinct values of some lines.
const lines = (values: number[]): number[] => [...new Set(values)].toSorted((a, b) => a - b)

// An edge between two nodes, however it is walked.
const key = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

// A route's points with the straight stretches' middle points left out.
const corners = (points: Point[]): Point[] =>
  points.filter((p, i) => {
    const a = points[i - 1]
    const b = points[i + 1]
    return !a || !b || !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
  })

const length = (path: readonly Point[]): number =>
  path.reduce((sum, p, i) => {
    const a = path[i - 1]
    return a ? sum + Math.abs(p[0] - a[0]) + Math.abs(p[1] - a[1]) : 0
  }, 0)

// The edges some route used as whole runs, collinear edges that touch made one.
const merged = (used: ReadonlySet<string>, point: (n: number) => Point): Run[] => {
  const segments = [...used].map((id) => {
    const [a, b] = id.split(":").map(Number) as [number, number]
    const [x1, y1] = point(a)
    const [x2, y2] = point(b)
    return x1 === x2
      ? {
          axis: "vertical" as const,
          line: x1,
          from: Math.min(y1, y2),
          to: Math.max(y1, y2),
        }
      : {
          axis: "horizontal" as const,
          line: y1,
          from: Math.min(x1, x2),
          to: Math.max(x1, x2),
        }
  })
  const ordered = segments.toSorted(
    (a, b) => a.axis.localeCompare(b.axis) || a.line - b.line || a.from - b.from,
  )
  const runs: { axis: Run["axis"]; line: number; from: number; to: number }[] = []
  for (const segment of ordered) {
    const last = runs[runs.length - 1]
    if (last && last.axis === segment.axis && last.line === segment.line && last.to >= segment.from)
      last.to = Math.max(last.to, segment.to)
    else runs.push({ ...segment })
  }
  return runs.map(({ axis, line, from, to }) =>
    axis === "vertical"
      ? { axis, x: line, y: from, length: to - from }
      : { axis, x: from, y: line, length: to - from },
  )
}
