import { describe, expect, it } from "../test"
import { planMotion, type Frame } from "./files-motion"
import { rowHeight } from "./files-window"

// A frame of lines in order, scrolled to `scrollTop`, drawing `drawn` (all of them by default).
const frame = (
  lines: readonly string[],
  scrollTop = 0,
  drawn: readonly string[] = lines,
): Frame => ({
  scrollTop,
  lineOf: new Map(lines.map((key, index) => [key, index])),
  drawn,
})

const view = rowHeight * 10

describe("The Files tree's motion as it filters", () => {
  it("slides the rows that stay, fades the rows that go and the rows that come", () => {
    const whole = frame(["src", "src/a.ts", "src/b.ts", "src/c.ts"])
    const kept = frame(["src", "src/c.ts"])
    expect(planMotion(whole, kept, view)).toEqual({
      moves: [{ key: "src/c.ts", from: rowHeight * 2 }],
      entering: [],
      leaving: [
        { key: "src/a.ts", top: rowHeight, shift: undefined },
        { key: "src/b.ts", top: rowHeight * 2, shift: undefined },
      ],
    })
    expect(planMotion(kept, whole, view)).toEqual({
      moves: [{ key: "src/c.ts", from: -rowHeight * 2 }],
      entering: ["src/a.ts", "src/b.ts"],
      leaving: [],
    })
  })

  it("plans on the screen, so a scroll clamped as the tree shrinks moves nothing by itself", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `f${index}`)
    // Scrolled 20 rows down, f25 sits 5 rows down the view; filtered, the tree no longer scrolls
    // and f25 is its second line.
    const whole = frame(lines, rowHeight * 20, lines.slice(20, 30))
    const kept = frame(["f0", "f25"])
    const plan = planMotion(whole, kept, view)
    // f0 was 20 rows above the view: it slides in from just past the top, not from far off.
    expect(plan.moves).toEqual([
      { key: "f0", from: -rowHeight },
      { key: "f25", from: rowHeight * 4 },
    ])
    expect(plan.leaving.find((ghost) => ghost.key === "f20")).toEqual({
      key: "f20",
      top: 0,
      shift: undefined,
    })
  })

  it("brings a row from far off in from just past the edge", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `f${index}`)
    const whole = frame(lines, 0, lines.slice(0, 20))
    const kept = frame(["f150"])
    expect(planMotion(whole, kept, view).moves).toEqual([{ key: "f150", from: view }])
  })

  it("slides a row that stays but goes off screen to the edge, and leaves the rest alone", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `f${index}`)
    const kept = frame(["f3", "f150"])
    const whole = frame(lines, 0, lines.slice(0, 20))
    const plan = planMotion(kept, whole, view)
    expect(plan.leaving).toEqual([{ key: "f150", top: rowHeight, shift: view - rowHeight }])
    // f3 slides three rows down; of the rest, only the rows on screen fade in.
    expect(plan.moves).toEqual([{ key: "f3", from: -rowHeight * 3 }])
    expect(plan.entering).toHaveLength(10 - 1)
  })
})
