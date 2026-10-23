import { describe, expect, it } from "../../../../test"
import { cellsPath, hopped, ledGrid } from "./led"

describe("an avatar's LED grid", () => {
  it("lays cells on whole device pixels, a one-pixel gap from three pixels a cell", () => {
    expect(ledGrid(30, 1)).toEqual({ device: 30, cell: 3, gap: 1, offset: 3 })
    expect(ledGrid(30, 2)).toEqual({ device: 60, cell: 7, gap: 1, offset: 2 })
    expect(ledGrid(22, 1)).toEqual({ device: 22, cell: 2, gap: 0, offset: 3 })
  })

  it("takes the view's zoom with the screen's ratio", () => {
    expect(ledGrid(26, 1.5)).toEqual({ device: 39, cell: 4, gap: 1, offset: 3 })
  })

  it("draws each cell a square of its grid, less the gap", () => {
    expect(cellsPath(ledGrid(30, 1), [[1, 2]])).toBe("M6 9h2v2h-2z")
  })
})

describe("a critter's hop", () => {
  const empty = "........"
  const body = "..####.."

  it("goes a row up where the top row is clear", () => {
    expect(hopped([empty, body, body, body, body, body, body, body])).toEqual([
      body,
      body,
      body,
      body,
      body,
      body,
      body,
      empty,
    ])
  })

  it("goes a row down where only the bottom row is clear", () => {
    expect(hopped([body, body, body, body, body, body, body, empty])[0]).toBe(empty)
  })

  it("goes a row up past the screen's edge when it fills the screen", () => {
    expect(hopped(Array.from({ length: 8 }, () => body)).at(-1)).toBe(empty)
  })
})
