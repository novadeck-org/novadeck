import { describe as context, describe, expect, it } from "vitest"

import {
  teamRoute,
  teamRoutes,
  tileBoxes,
  type Run,
  type TeamRoute,
  type TileBox,
} from "./team-route"

const gap = 16
const width = 1000

// A tile on a grid of 300px columns, 400px rows, with the gap between them.
const tile = (id: string, column: number, row: number, columns = 1, rows = 1): TileBox => ({
  id,
  left: column * (300 + gap),
  top: row * (400 + gap),
  width: columns * 300 + (columns - 1) * gap,
  height: rows * 400 + (rows - 1) * gap,
})

const crosses = (run: Run, box: TileBox): boolean => {
  const [x2, y2] =
    run.axis === "horizontal" ? [run.x + run.length, run.y] : [run.x, run.y + run.length]
  return (
    box.left < Math.max(run.x, x2) &&
    Math.min(run.x, x2) < box.left + box.width &&
    box.top < Math.max(run.y, y2) &&
    Math.min(run.y, y2) < box.top + box.height
  )
}

const never = (route: TeamRoute | undefined, boxes: readonly TileBox[]): void => {
  for (const run of route!.runs) for (const box of boxes) expect(crosses(run, box)).toBe(false)
}

describe("The team wire's route", () => {
  context("with the lead and a worker side by side", () => {
    const boxes = [tile("lead", 0, 0), tile("worker", 1, 0)]
    const route = teamRoute(boxes, "lead", ["worker"], gap, width)

    it("puts the cursor in the gutter left of the lead on its header line", () => {
      expect(route!.cursor).toEqual([-8, 27])
    })

    it("ends in a tick into the worker's left edge on its header line", () => {
      expect(route!.workers[0]!.tick).toEqual({
        axis: "horizontal",
        x: 316 - 8,
        y: 27,
        length: 8,
      })
    })

    it("goes round the lead's tile through the gutters", () => {
      never(route, boxes)
      expect(route!.workers[0]!.distance).toBeGreaterThan(300)
      expect(route!.workers[0]!.path[0]).toEqual([-8, 27])
      expect(route!.workers[0]!.path.at(-1)).toEqual([308, 27])
    })
  })

  context("with workers on other rows", () => {
    const boxes = [tile("lead", 0, 0), tile("a", 1, 0), tile("b", 0, 1), tile("c", 1, 1)]
    const route = teamRoute(boxes, "lead", ["a", "b", "c"], gap, width)

    it("reaches each worker without crossing a tile", () => {
      expect(route!.workers.map((worker) => worker.id).toSorted()).toEqual(["a", "b", "c"])
      never(route, boxes)
    })

    it("shares the stretch the routes have in common", () => {
      const sum = route!.runs.reduce((total, run) => total + run.length, 0)
      const separate = route!.workers.reduce((total, worker) => total + worker.distance, 0)
      expect(sum).toBeLessThan(separate)
    })
  })

  context("with a tall tile between the lead and its worker", () => {
    it("goes round it", () => {
      const boxes = [tile("lead", 0, 0), tile("wall", 1, 0, 1, 2), tile("worker", 2, 0)]
      const route = teamRoute(boxes, "lead", ["worker"], gap, width)
      never(route, boxes)
      // Over the top, through the stage's padding, not down the wall's far side.
      expect(route!.runs.some((run) => run.axis === "horizontal" && run.y === -8)).toBe(true)
    })
  })

  context("with a worker in a wider tile spanning columns", () => {
    it("meets it on its own left edge", () => {
      const boxes = [tile("lead", 0, 0), tile("wide", 0, 1, 3)]
      const route = teamRoute(boxes, "lead", ["wide"], gap, width)
      never(route, boxes)
      expect(route!.workers[0]!.tick.x).toBe(-8)
      expect(route!.workers[0]!.tick.y).toBe(416 + 27)
    })
  })

  context("with a worker or two that are not among the tiles or can't be reached", () => {
    // A stray box over the walled tile's gutter shuts its tick's end off from every side.
    const stray: TileBox = { id: "stray", left: 2 * 316 - 20, top: 0, width: 16, height: 400 }
    const boxes = [tile("lead", 0, 0), tile("worker", 1, 0), tile("walled", 2, 0), stray]

    it("draws the rest", () => {
      const route = teamRoute(boxes, "lead", ["worker", "walled", "missing"], gap, width)
      expect(route!.workers.map((worker) => worker.id)).toEqual(["worker"])
    })

    it("draws nothing when none can be reached", () => {
      expect(teamRoute(boxes, "lead", ["walled", "missing"], gap, width)).toBeUndefined()
    })
  })

  context("with many irregular tiles and three teams", () => {
    it("finds its way in well under a frame", () => {
      const many = Array.from({ length: 60 }, (_, i) => ({
        id: `t${i}`,
        left: (i % 4) * 316,
        top: Math.floor(i / 4) * 300 + ((i * 37) % 5) * 40,
        width: 300,
        height: 200 + ((i * 53) % 4) * 25,
      }))
      const start = performance.now()
      const routes = teamRoutes(
        many,
        [
          { lead: "t0", workers: ["t7", "t30", "t45"] },
          { lead: "t2", workers: ["t11", "t38"] },
          { lead: "t13", workers: ["t50", "t59", "t21"] },
        ],
        gap,
        1264,
      )
      expect(routes.map((route) => route?.workers.length)).toEqual([3, 2, 3])
      expect(performance.now() - start).toBeLessThan(100)
    })
  })

  context("with no lead or no worker among the tiles", () => {
    const boxes = [tile("lead", 0, 0), tile("worker", 1, 0)]

    it("draws nothing without the lead", () => {
      expect(teamRoute(boxes, "gone", ["worker"], gap, width)).toBeUndefined()
    })

    it("draws nothing without a worker", () => {
      expect(teamRoute(boxes, "lead", ["gone"], gap, width)).toBeUndefined()
    })
  })
})

describe("Several teams' wires", () => {
  // Two teams in a row of tiles over a row of tiles: both leads on the left.
  const boxes = [
    tile("a", 0, 0),
    tile("a1", 1, 0),
    tile("b", 0, 1),
    tile("b1", 1, 1),
    tile("a2", 2, 0),
    tile("b2", 2, 1),
  ]
  const crews = [
    { lead: "a", workers: ["a1", "a2"] },
    { lead: "b", workers: ["b1", "b2"] },
  ]

  it("draws each team's wire, none crossing a tile", () => {
    const routes = teamRoutes(boxes, crews, gap, width)
    expect(routes.map((route) => route?.workers.length)).toEqual([2, 2])
    for (const route of routes) never(route, boxes)
  })

  it("keeps the teams on runs of their own where the grid has room", () => {
    const [a, b] = teamRoutes(boxes, crews, gap, width)
    // Whether two runs on one line cover a stretch in common, not merely touch.
    const shares = (one: Run, two: Run): boolean =>
      one.axis === two.axis &&
      (one.axis === "horizontal"
        ? one.y === two.y && one.x < two.x + two.length && two.x < one.x + one.length
        : one.x === two.x && one.y < two.y + two.length && two.y < one.y + one.length)
    expect(b!.runs.filter((run) => a!.runs.some((other) => shares(run, other)))).toEqual([])
  })

  it("leaves a team out that has no lead or no worker among the tiles", () => {
    const routes = teamRoutes(boxes, [{ lead: "gone", workers: ["a1"] }, crews[1]!], gap, width)
    expect(routes.map((route) => route !== undefined)).toEqual([false, true])
  })
})

describe("The tiles' boxes", () => {
  it("follow the grid's columns, rows and margin", () => {
    // Twelve columns of 64px with 16px between them.
    const [box] = tileBoxes([{ i: "a", x: 4, y: 2, w: 4, h: 10 }], 944, 12, 8, 16)
    expect(box).toEqual({
      id: "a",
      left: 320,
      top: 48,
      width: 304,
      height: 224,
    })
  })
})
