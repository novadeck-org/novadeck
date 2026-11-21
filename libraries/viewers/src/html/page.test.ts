import { describe, expect, it } from "vitest"

import { buildPage, pageNames, type PageFile } from "./page.js"

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const file = (name: string, text = name): [string, PageFile] => [name, { name, bytes: bytes(text) }]
const documentOf = (html: string): Document => new DOMParser().parseFromString(html, "text/html")
const base64 = (text: string): string => btoa(text)

describe("the files a page names", () => {
  it("are its stylesheets, pictures and what they name, each once", () => {
    const html = `<!doctype html>
      <link rel="icon" href="favicon.ico">
      <link rel="Stylesheet preload" href="strip.css?v=2">
      <style>@import "reset.css"; .a { background: url(img/bg.png) }</style>
      <p style="background: url(img/inline.png)">hi</p>
      <img src="img/a.png" srcset="img/a.png 1x, img/a@2x.png 2x">
      <picture><source srcset="img/wide.webp 800w"><img src="https://example.com/x.png"></picture>
      <img src="data:image/png;base64,AAAA"><img src="../outside.png"><img src="#top">
      <video poster="img/poster.jpg" src="movie.mp4"></video>
      <svg><image href="img/vector.svg"></image></svg>
      <script src="app.js"></script>`
    expect(pageNames(html).toSorted()).toEqual([
      "img/a.png",
      "img/a@2x.png",
      "img/bg.png",
      "img/inline.png",
      "img/poster.jpg",
      "img/vector.svg",
      "img/wide.webp",
      "reset.css",
      "strip.css",
    ])
  })

  it("are none for a page that names nothing", () => {
    expect(pageNames("<p>hi</p>")).toEqual([])
    expect(pageNames("")).toEqual([])
  })
})

describe("a page built from its files", () => {
  const files = new Map([
    file("strip.css", '@import "fonts.css";\nbody { background: url(img/bg.png) }'),
    file("fonts.css", "@font-face { font-family: A; src: url(fonts/a.woff2) }"),
    file("fonts/a.woff2", "font bytes"),
    file("img/bg.png", "bg"),
    file("img/a.png", "a"),
    file("img/b.png", "b"),
    file("reset.css", "* { margin: 0 }"),
  ])

  it("has its stylesheets as styles, with their imports and addresses put in", () => {
    const built = documentOf(
      buildPage(
        '<!doctype html><link rel="stylesheet" href="strip.css" media="screen"><p>hi</p>',
        files,
      ),
    )
    expect(built.querySelector("link")).toBeNull()
    const style = built.querySelector("style")!
    expect(style.getAttribute("media")).toBe("screen")
    expect(style.textContent).toContain(`url("data:font/woff2;base64,${base64("font bytes")}")`)
    expect(style.textContent).toContain(`url("data:image/png;base64,${base64("bg")}")`)
    expect(style.textContent).not.toContain("@import")
  })

  it("has an import with a media query inside it, and one named twice read once", () => {
    const built = documentOf(
      buildPage(
        '<style>@import url(reset.css) print;\n@import "reset.css";</style><style>@import "strip.css";</style>',
        files,
      ),
    )
    const [first, second] = [...built.querySelectorAll("style")]
    expect(first!.textContent).toContain("@media print {* { margin: 0 }}")
    expect(second!.textContent).toContain("data:font/woff2")
  })

  it("has its pictures as data addresses, in attributes, sets and inline styles", () => {
    const built = documentOf(
      buildPage(
        `<img src="img/a.png" srcset="img/a.png 1x, img/b.png 2x"><p style="background:url(img/b.png)">x</p>
         <video poster="img/a.png"></video>`,
        files,
      ),
    )
    expect(built.querySelector("img")!.getAttribute("src")).toBe(
      `data:image/png;base64,${base64("a")}`,
    )
    expect(built.querySelector("img")!.getAttribute("srcset")).toBe(
      `data:image/png;base64,${base64("a")} 1x, data:image/png;base64,${base64("b")} 2x`,
    )
    expect(built.querySelector("p")!.getAttribute("style")).toContain(base64("b"))
    expect(built.querySelector("video")!.getAttribute("poster")).toContain(base64("a"))
  })

  it("leaves what isn't among its files as it is, and drops a stylesheet link that isn't", () => {
    const built = documentOf(
      buildPage(
        '<link rel="stylesheet" href="gone.css"><link rel="icon" href="x.ico"><img src="gone.png"><img src="https://example.com/x.png">',
        files,
      ),
    )
    expect(built.querySelector("link")).toBeNull()
    expect([...built.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "gone.png",
      "https://example.com/x.png",
    ])
  })

  it("takes out what would run or load by itself", () => {
    const built = documentOf(
      buildPage(
        `<head><base href="https://example.com/"><meta http-equiv="refresh" content="0;url=https://example.com"><meta charset="utf-8"></head>
         <body><script>alert(1)</script><script src="x.js"></script><iframe src="https://example.com"></iframe>
         <object data="x"></object><embed src="x"><p>kept</p></body>`,
        files,
      ),
    )
    for (const selector of ["script", "base", "iframe", "object", "embed", "meta[http-equiv]"])
      expect(built.querySelector(selector), selector).toBeNull()
    expect(built.querySelector("meta[charset]")).not.toBeNull()
    expect(built.querySelector("p")!.textContent).toBe("kept")
  })

  it("keeps a page's doctype, and a page without one stays without", () => {
    expect(buildPage("<!DOCTYPE html><p>a</p>", files).startsWith("<!doctype html>")).toBe(true)
    expect(buildPage("<p>a</p>", files).startsWith("<html>")).toBe(true)
  })

  it("follows no import in a loop, nor one past its depth", () => {
    const loop = new Map([
      file("a.css", '@import "b.css"; .a { color: red }'),
      file("b.css", '@import "a.css"; .b { color: blue }'),
    ])
    const built = documentOf(buildPage('<link rel="stylesheet" href="a.css">', loop))
    const text = built.querySelector("style")!.textContent!
    expect(text).toContain(".a { color: red }")
    expect(text).toContain(".b { color: blue }")
    expect(text).not.toContain("@import")
  })
})
