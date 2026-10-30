import { describe, expect, it } from "../test.js"
import { readCloseShownRequest, readLookRequest, readShowRequest } from "./request.js"

describe("a show request", () => {
  it("names a file by its path, and only lines that run forward, under file", () => {
    expect(
      readShowRequest({ file: { path: "a.ts", lines: { from: 2, to: 2 } }, open: true }),
    ).toEqual({
      ok: true,
      request: { file: { path: "a.ts", lines: { from: 2, to: 2 } }, open: true },
    })
    expect(readShowRequest({ file: { path: "a.ts", lines: { from: 3, to: 2 } } })).toEqual({
      ok: false,
      reason: 'The request\'s "file.lines" is not valid.',
    })
    expect(readShowRequest({ file: { path: "" } })).toMatchObject({
      ok: false,
      reason: 'The request\'s "file.path" is not valid.',
    })
    expect(readShowRequest({ file: { path: "a.ts" }, title: "t".repeat(257) })).toMatchObject({
      ok: false,
    })
    expect(readShowRequest({ file: { path: "a.ts" }, extra: 1 })).toMatchObject({ ok: false })
    expect(readShowRequest({ file: { path: "a.ts", open: true } })).toMatchObject({
      ok: false,
      reason: 'The request\'s "file.open" is not valid.',
    })
  })

  it("names a page by its url, or a file, never both, and lines only inside a file", () => {
    expect(readShowRequest({ page: { url: "http://localhost:5173/" }, open: true })).toEqual({
      ok: true,
      request: { page: { url: "http://localhost:5173/" }, open: true },
    })
    expect(
      readShowRequest({ page: { url: "http://localhost:5173/" }, file: { path: "a.ts" } }),
    ).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }, not several.",
    })
    expect(
      readShowRequest({ page: { url: "http://a/" }, lines: { from: 1, to: 1 } }),
    ).toMatchObject({
      ok: false,
      reason: 'The request\'s "lines" is not valid.',
    })
    expect(
      readShowRequest({ page: { url: "http://a/", lines: { from: 1, to: 1 } } }),
    ).toMatchObject({
      ok: false,
      reason: 'The request\'s "page.lines" is not valid.',
    })
    expect(readShowRequest({ page: { url: "" } })).toMatchObject({ ok: false })
    expect(readShowRequest({})).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }.",
    })
    // A flat address or path, with no source around it, is told the shape.
    for (const flat of [{ path: "a.ts" }, { url: "http://localhost:5173/" }])
      expect(readShowRequest(flat)).toEqual({
        ok: false,
        reason: "Give one source, file: { path }, page: { url } or changes: { path? }.",
      })
    expect(readShowRequest("a.ts")).toEqual({ ok: false, reason: "The request is not valid." })
    expect(readShowRequest({ page: { url: "http://a/" }, ['x"y'.repeat(40)]: 1 })).toEqual({
      ok: false,
      reason: `The request's ${JSON.stringify('x"y'.repeat(21) + "…")} is not valid.`,
    })
  })

  it("takes a page's element to scroll to, trimmed, as one CSS selector", () => {
    expect(readShowRequest({ page: { url: "http://a/", scroll: "  #pricing " } })).toEqual({
      ok: true,
      request: { page: { url: "http://a/", scroll: "#pricing" } },
    })
    for (const scroll of ["", "   ", "x".repeat(1025), 1])
      expect(readShowRequest({ page: { url: "http://a/", scroll } })).toEqual({
        ok: false,
        reason: 'The request\'s "page.scroll" is not valid.',
      })
  })
})

describe("a close request", () => {
  it("names the file or page given to show, and nothing else", () => {
    expect(readCloseShownRequest({ file: { path: "a.ts" } })).toEqual({
      ok: true,
      request: { file: { path: "a.ts" } },
    })
    expect(readCloseShownRequest({ page: { url: "http://localhost:5173/" } })).toEqual({
      ok: true,
      request: { page: { url: "http://localhost:5173/" } },
    })
    expect(readCloseShownRequest({ file: { path: "a.ts", lines: { from: 1, to: 1 } } })).toEqual({
      ok: false,
      reason: 'The request\'s "file.lines" is not valid.',
    })
    expect(readCloseShownRequest({ page: { url: "http://a/", scroll: "#a" } })).toEqual({
      ok: false,
      reason: 'The request\'s "page.scroll" is not valid.',
    })
    expect(readCloseShownRequest({ file: { path: "a.ts" }, open: true })).toEqual({
      ok: false,
      reason: 'The request\'s "open" is not valid.',
    })
    expect(readCloseShownRequest({ file: { path: "a.ts" }, page: { url: "http://a/" } })).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }, not several.",
    })
    expect(readCloseShownRequest({})).toEqual({
      ok: false,
      reason: "Give one source, file: { path }, page: { url } or changes: { path? }.",
    })
  })
})

describe("a request for the changes", () => {
  it("is changes {} with the shared title and open, and takes only a folder", () => {
    expect(readShowRequest({ changes: {} })).toEqual({ ok: true, request: { changes: {} } })
    expect(readShowRequest({ changes: {}, title: "Work", open: true })).toEqual({
      ok: true,
      request: { changes: {}, title: "Work", open: true },
    })
    expect(readShowRequest({ changes: { path: "../wt" } })).toEqual({
      ok: true,
      request: { changes: { path: "../wt" } },
    })
    expect(readCloseShownRequest({ changes: { path: "../wt" } })).toMatchObject({ ok: true })
    expect(readShowRequest({ changes: { path: "" } })).toMatchObject({ ok: false })
    expect(readShowRequest({ changes: { base: "main" } })).toEqual({
      ok: false,
      reason: 'The request\'s "changes.base" is not valid.',
    })
    expect(readShowRequest({ changes: {}, file: { path: "a.ts" } })).toMatchObject({ ok: false })
    expect(readCloseShownRequest({ changes: {} })).toEqual({ ok: true, request: { changes: {} } })
    expect(readCloseShownRequest({ changes: { paths: [] } })).toMatchObject({ ok: false })
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
