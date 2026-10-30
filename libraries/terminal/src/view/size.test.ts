import { describe, expect, it } from "vitest"

import { clampSize } from "./screens.js"

describe("terminal size", () => {
  it("keeps a fitted size within what a terminal accepts", () => {
    expect(
      [
        { cols: 1, rows: 0 },
        { cols: 120.7, rows: 30.2 },
        { cols: 900, rows: 400 },
      ].map(clampSize),
    ).toEqual([
      { cols: 2, rows: 1 },
      { cols: 120, rows: 30 },
      { cols: 500, rows: 200 },
    ])
  })
})
