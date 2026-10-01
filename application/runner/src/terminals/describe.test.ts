import { describe, expect, it } from "../test.js"
import { readDescribeRequest } from "./describe.js"

describe("a description's request", () => {
  it("takes a title, a summary and whether the person asked", () => {
    expect(readDescribeRequest({ title: "API", summary: "Builds it.", asked: true })).toEqual({
      ok: true,
      request: { title: "API", summary: "Builds it.", asked: true },
    })
  })

  it("says what's wrong with one it can't take", () => {
    expect(readDescribeRequest({ title: "API", summary: "x", asked: "yes" })).toEqual({
      ok: false,
      reason: "`asked` must be true or false.",
    })
    expect(readDescribeRequest({ title: "x".repeat(2000), summary: "x" })).toEqual({
      ok: false,
      reason: "The title is far too long.",
    })
    expect(readDescribeRequest({ summary: "x" })).toEqual({
      ok: false,
      reason: "A description needs a `title` and a `summary`, both text.",
    })
    // There is no target: it is always the caller's own terminal.
    expect(readDescribeRequest({ title: "API", summary: "x", to: "t2" })).toEqual({
      ok: false,
      reason: "A description takes only `title`, `summary` and `asked`.",
    })
  })
})
