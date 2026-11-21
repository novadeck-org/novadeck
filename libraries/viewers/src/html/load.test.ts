import { describe, expect, it } from "vitest"

import { loadPage, pageKey, pageLimits, type ReadPageFile } from "./load.js"

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>

// A folder's files, asked for by name, and the names asked for.
const folder = (files: { readonly [name: string]: string | Uint8Array<ArrayBuffer> }) => {
  const asked: string[] = []
  const read: ReadPageFile = (name) => {
    asked.push(name)
    const found = files[name]
    return Promise.resolve(typeof found === "string" ? bytes(found) : found)
  }
  return { asked, read }
}

const run = (html: string, read: ReadPageFile, signal = new AbortController().signal) =>
  loadPage({ html, read, signal })

describe("a page's files", () => {
  it("are those its text names and those its stylesheets name, each read once", async () => {
    const { asked, read } = folder({
      "strip.css":
        '@import "base.css"; @font-face { src: url(fonts/a.woff2) } .a { background: url(a.png) }',
      "base.css": "body { background: url(a.png) }",
      "fonts/a.woff2": "font",
      "a.png": "png",
    })
    const files = await run('<link rel="stylesheet" href="strip.css"><img src="a.png">', read)
    expect(files!.map((file) => file.name).toSorted()).toEqual([
      "a.png",
      "base.css",
      "fonts/a.woff2",
      "strip.css",
    ])
    expect(asked.toSorted()).toEqual(["a.png", "base.css", "fonts/a.woff2", "strip.css"])
  })

  it("are read from the folder of the stylesheet that names them", async () => {
    const { asked, read } = folder({
      "css/strip.css": ".a { background: url(../img/a.png) } .b { background: url(b.png) }",
      "img/a.png": "a",
      "css/b.png": "b",
    })
    await run('<link rel="stylesheet" href="css/strip.css">', read)
    expect(asked.toSorted()).toEqual(["css/b.png", "css/strip.css", "img/a.png"])
  })

  it("leave out what can't be read, and the page draws without it", async () => {
    const { read } = folder({ "a.png": "a" })
    const files = await run('<img src="a.png"><img src="gone.png">', read)
    expect(files!.map((file) => file.name)).toEqual(["a.png"])
  })

  it("stop at the limits: how many, how large, how large all told", async () => {
    const many = Array.from({ length: pageLimits.files + 10 }, (_, at) => `<img src="${at}.png">`)
    const all = Object.fromEntries(many.map((_, at) => [`${at}.png`, "x"]))
    expect((await run(many.join(""), folder(all).read))!.length).toBe(pageLimits.files)
    const big = new Uint8Array(pageLimits.file + 1)
    expect(await run('<img src="big.png">', folder({ "big.png": big }).read)).toEqual([])
    const part = new Uint8Array(pageLimits.file - 1)
    const three = await run(
      '<img src="a.png"><img src="b.png"><img src="c.png">',
      folder({ "a.png": part, "b.png": part, "c.png": part }).read,
    )
    expect(three!.map((file) => file.name)).toEqual(["a.png", "b.png"])
  })

  it("follow a loop of stylesheets once", async () => {
    const { asked, read } = folder({
      "a.css": '@import "b.css";',
      "b.css": '@import "a.css";',
    })
    await run('<link rel="stylesheet" href="a.css">', read)
    expect(asked).toEqual(["a.css", "b.css"])
  })

  it("are none once the caller stops waiting", async () => {
    const stop = new AbortController()
    const read: ReadPageFile = async () => {
      stop.abort()
      return bytes("x")
    }
    expect(await run('<img src="a.png">', read, stop.signal)).toBeUndefined()
  })
})

describe("a page's key", () => {
  const page = '<link rel="stylesheet" href="a.css">'
  const file = (name: string, text: string) => ({ name, bytes: bytes(text) })

  it("is the same for the same text and bytes, and another once either changes", () => {
    const key = pageKey(page, [file("a.css", "a {}")])
    expect(pageKey(page, [file("a.css", "a {}")])).toBe(key)
    expect(pageKey(`${page} `, [file("a.css", "a {}")])).not.toBe(key)
    expect(pageKey(page, [file("a.css", "b {}")])).not.toBe(key)
    expect(pageKey(page, [file("b.css", "a {}")])).not.toBe(key)
    expect(pageKey(page, [])).not.toBe(key)
  })
})
