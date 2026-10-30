import { describe, expect, it } from "../test.js"
import { readDismissRequest, readLookRequest, readRequest } from "./request.js"

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
    expect(readRequest({ page: { url: "http://localhost:5173/" }, open: true })).toEqual({
      ok: true,
      request: { page: { url: "http://localhost:5173/" }, open: true },
    })
    expect(
      readRequest({ page: { url: "http://localhost:5173/" }, file: { path: "a.ts" } }),
    ).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }, not several.",
    })
    expect(readRequest({ page: { url: "http://a/" }, lines: { from: 1, to: 1 } })).toMatchObject({
      ok: false,
      reason: 'The request\'s "lines" is not valid.',
    })
    expect(readRequest({ page: { url: "http://a/", lines: { from: 1, to: 1 } } })).toMatchObject({
      ok: false,
      reason: 'The request\'s "page.lines" is not valid.',
    })
    expect(readRequest({ page: { url: "" } })).toMatchObject({ ok: false })
    expect(readRequest({})).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }.",
    })
    // A flat address or path, with no source around it, is told the shape.
    for (const flat of [{ path: "a.ts" }, { url: "http://localhost:5173/" }])
      expect(readRequest(flat)).toEqual({
        ok: false,
        reason: "Give one source, file: { path }, page: { url } or changes: { path? }.",
      })
    expect(readRequest("a.ts")).toEqual({ ok: false, reason: "The request is not valid." })
    expect(readRequest({ page: { url: "http://a/" }, ['x"y'.repeat(40)]: 1 })).toEqual({
      ok: false,
      reason: `The request's ${JSON.stringify('x"y'.repeat(21) + "…")} is not valid.`,
    })
  })

  it("takes a page's element to scroll to, trimmed, as one CSS selector", () => {
    expect(readRequest({ page: { url: "http://a/", scroll: "  #pricing " } })).toEqual({
      ok: true,
      request: { page: { url: "http://a/", scroll: "#pricing" } },
    })
    for (const scroll of ["", "   ", "x".repeat(1025), 1])
      expect(readRequest({ page: { url: "http://a/", scroll } })).toEqual({
        ok: false,
        reason: 'The request\'s "page.scroll" is not valid.',
      })
  })
})

describe("a close request", () => {
  it("names the file or page given to show, and nothing else", () => {
    expect(readDismissRequest({ file: { path: "a.ts" } })).toEqual({
      ok: true,
      request: { file: { path: "a.ts" } },
    })
    expect(readDismissRequest({ page: { url: "http://localhost:5173/" } })).toEqual({
      ok: true,
      request: { page: { url: "http://localhost:5173/" } },
    })
    expect(readDismissRequest({ file: { path: "a.ts", lines: { from: 1, to: 1 } } })).toEqual({
      ok: false,
      reason: 'The request\'s "file.lines" is not valid.',
    })
    expect(readDismissRequest({ page: { url: "http://a/", scroll: "#a" } })).toEqual({
      ok: false,
      reason: 'The request\'s "page.scroll" is not valid.',
    })
    expect(readDismissRequest({ file: { path: "a.ts" }, open: true })).toEqual({
      ok: false,
      reason: 'The request\'s "open" is not valid.',
    })
    expect(readDismissRequest({ file: { path: "a.ts" }, page: { url: "http://a/" } })).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }, not several.",
    })
    expect(readDismissRequest({})).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }.",
    })
  })
})

describe("a request for the changes", () => {
  it("is changes {} with the shared title and open, and takes only a folder", () => {
    expect(readRequest({ changes: {} })).toEqual({ ok: true, request: { changes: {} } })
    expect(readRequest({ changes: {}, title: "Work", open: true })).toEqual({
      ok: true,
      request: { changes: {}, title: "Work", open: true },
    })
    expect(readRequest({ changes: { path: "../wt" } })).toEqual({
      ok: true,
      request: { changes: { path: "../wt" } },
    })
    expect(readDismissRequest({ changes: { path: "../wt" } })).toMatchObject({ ok: true })
    expect(readRequest({ changes: { path: "" } })).toMatchObject({ ok: false })
    expect(readRequest({ changes: { base: "main" } })).toEqual({
      ok: false,
      reason: 'The request\'s "changes.base" is not valid.',
    })
    expect(readRequest({ changes: {}, file: { path: "a.ts" } })).toMatchObject({ ok: false })
    expect(readDismissRequest({ changes: {} })).toEqual({ ok: true, request: { changes: {} } })
    expect(readDismissRequest({ changes: { paths: [] } })).toMatchObject({ ok: false })
  })
})

describe("a look request", () => {
  it("takes a page by its address, or nothing", () => {
    expect(readLookRequest({})).toEqual({ ok: true, request: {} })
    expect(readLookRequest({ page: { url: "http://localhost:5173/" } })).toEqual({
      ok: true,
      request: { page: { url: "http://localhost:5173/" } },
    })
  })

  it("names what else is wrong", () => {
    expect(readLookRequest({ page: {} })).toEqual({
      ok: false,
      reason: 'The request\'s "page.url" is not valid.',
    })
    expect(readLookRequest({ page: { url: "http://a/", scroll: "#x" } })).toEqual({
      ok: false,
      reason: 'The request\'s "page.scroll" is not valid.',
    })
    expect(readLookRequest({ file: { path: "a" } })).toEqual({
      ok: false,
      reason: 'The request\'s "file" is not valid.',
    })
  })
})
