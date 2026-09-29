import { describe, expect, it } from "../../test"
import { runnerSize } from "./screens"

describe("runner terminal size", () => {
  it("keeps a fitted size within what the runner accepts", () => {
    expect(
      [
        { cols: 1, rows: 0 },
        { cols: 120.7, rows: 30.2 },
        { cols: 900, rows: 400 },
      ].map(runnerSize),
    ).toEqual([
      { cols: 2, rows: 1 },
      { cols: 120, rows: 30 },
      { cols: 500, rows: 200 },
    ])
  })
})
