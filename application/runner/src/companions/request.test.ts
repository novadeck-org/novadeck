import { describe, expect, it } from "../test.js"
import { readRequest } from "./request.js"

describe("a show request", () => {
  it("names a path, and only lines that run forward", () => {
    expect(readRequest({ path: "a.ts", lines: { from: 2, to: 2 }, open: true })).toEqual({
      ok: true,
      request: { path: "a.ts", lines: { from: 2, to: 2 }, open: true },
    })
    expect(readRequest({ path: "a.ts", lines: { from: 3, to: 2 } })).toEqual({
      ok: false,
      reason: 'The request\'s "lines" is not valid.',
    })
    expect(readRequest({ path: "" })).toMatchObject({ ok: false })
    expect(readRequest({ path: "a.ts", title: "t".repeat(257) })).toMatchObject({ ok: false })
    expect(readRequest({ path: "a.ts", extra: 1 })).toMatchObject({ ok: false })
  })

  it("names a page by its url, or a path, never both, and lines only for a file", () => {
    expect(readRequest({ url: "http://localhost:5173/", open: true })).toEqual({
      ok: true,
      request: { url: "http://localhost:5173/", open: true },
    })
    expect(readRequest({ url: "http://localhost:5173/", path: "a.ts" })).toEqual({
      ok: false,
      reason: "Give a path or a url, not both.",
    })
    expect(readRequest({ url: "http://a/", lines: { from: 1, to: 1 } })).toMatchObject({
      ok: false,
    })
    expect(readRequest({ url: "" })).toMatchObject({ ok: false })
    expect(readRequest({})).toEqual({ ok: false, reason: "Give a path or a url." })
  })
})
