import { describe, expect, it } from "../test.js"
import { readDismissRequest, readRequest } from "./request.js"

describe("a show request", () => {
  it("names a file by its path, and only lines that run forward, under file", () => {
    expect(readRequest({ file: { path: "a.ts", lines: { from: 2, to: 2 } }, open: true })).toEqual({
      ok: true,
      request: { file: { path: "a.ts", lines: { from: 2, to: 2 } }, open: true },
    })
    expect(readRequest({ file: { path: "a.ts", lines: { from: 3, to: 2 } } })).toEqual({
      ok: false,
      reason: 'The request\'s "file.lines" is not valid.',
    })
    expect(readRequest({ file: { path: "" } })).toMatchObject({
      ok: false,
      reason: 'The request\'s "file.path" is not valid.',
    })
    expect(readRequest({ file: { path: "a.ts" }, title: "t".repeat(257) })).toMatchObject({
      ok: false,
    })
    expect(readRequest({ file: { path: "a.ts" }, extra: 1 })).toMatchObject({ ok: false })
    expect(readRequest({ file: { path: "a.ts", open: true } })).toMatchObject({
      ok: false,
      reason: 'The request\'s "file.open" is not valid.',
    })
  })

  it("names a page by its url, or a file, never both, and lines only inside a file", () => {
    expect(readRequest({ url: "http://localhost:5173/", open: true })).toEqual({
      ok: true,
      request: { url: "http://localhost:5173/", open: true },
    })
    expect(readRequest({ url: "http://localhost:5173/", file: { path: "a.ts" } })).toEqual({
      ok: false,
      reason: "Give one source, file: { path } or url, not several.",
    })
    expect(readRequest({ url: "http://a/", lines: { from: 1, to: 1 } })).toMatchObject({
      ok: false,
      reason: 'The request\'s "lines" is not valid.',
    })
    expect(readRequest({ url: "" })).toMatchObject({ ok: false })
    expect(readRequest({})).toEqual({
      ok: false,
      reason: "Give one source, file: { path } or url.",
    })
    expect(readRequest({ path: "a.ts" })).toEqual({
      ok: false,
      reason: "Give one source, file: { path } or url.",
    })
    expect(readRequest("a.ts")).toEqual({ ok: false, reason: "The request is not valid." })
    expect(readRequest({ url: "http://a/", ['x"y'.repeat(40)]: 1 })).toEqual({
      ok: false,
      reason: `The request's ${JSON.stringify('x"y'.repeat(21) + "…")} is not valid.`,
    })
  })
})

describe("a close request", () => {
  it("names the file or url given to show, and nothing else", () => {
    expect(readDismissRequest({ file: { path: "a.ts" } })).toEqual({
      ok: true,
      request: { file: { path: "a.ts" } },
    })
    expect(readDismissRequest({ url: "http://localhost:5173/" })).toEqual({
      ok: true,
      request: { url: "http://localhost:5173/" },
    })
    expect(readDismissRequest({ file: { path: "a.ts", lines: { from: 1, to: 1 } } })).toEqual({
      ok: false,
      reason: 'The request\'s "file.lines" is not valid.',
    })
    expect(readDismissRequest({ file: { path: "a.ts" }, open: true })).toEqual({
      ok: false,
      reason: 'The request\'s "open" is not valid.',
    })
    expect(readDismissRequest({ file: { path: "a.ts" }, url: "http://a/" })).toEqual({
      ok: false,
      reason: "Give one source, file: { path } or url, not several.",
    })
    expect(readDismissRequest({})).toEqual({
      ok: false,
      reason: "Give one source, file: { path } or url.",
    })
  })
})
