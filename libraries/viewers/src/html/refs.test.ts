import { describe, expect, it } from "vitest"

import { cssAddresses, cssNames, folderOf, nameOf, typeOf } from "./refs.js"

describe("a name from a page's folder", () => {
  it("is the address as the page writes it, tidied", () => {
    expect(nameOf("", "strip.css")).toBe("strip.css")
    expect(nameOf("", "./img/a.png")).toBe("img/a.png")
    expect(nameOf("", "img//a.png?v=2#top")).toBe("img/a.png")
    expect(nameOf("", "a%20b.png")).toBe("a b.png")
    expect(nameOf("", "fonts\\a.woff2")).toBe("fonts/a.woff2")
  })

  it("is read from the folder of the file that writes it", () => {
    expect(nameOf("css", "../img/a.png")).toBe("img/a.png")
    expect(nameOf("css", "fonts/a.woff2")).toBe("css/fonts/a.woff2")
    expect(nameOf("css/deep", "../../a.png")).toBe("a.png")
  })

  it("is none for an address that leaves the page's folder", () => {
    for (const ref of ["../a.png", "img/../../a.png", "a/../../../b.png", "%2e%2e/a.png"])
      expect(nameOf("", ref), ref).toBeUndefined()
    expect(nameOf("css", "../../a.png")).toBeUndefined()
  })

  it("is none for an address that names nothing beside the page", () => {
    for (const ref of [
      "",
      "  ",
      "#top",
      "https://example.com/a.png",
      "HTTP://example.com/a.png",
      "//example.com/a.png",
      "data:image/png;base64,AAAA",
      "file:///etc/hosts",
      "blob:x",
      "javascript:alert(1)",
      "/etc/hosts",
      "\\\\host\\share\\a.png",
      "C:\\a.png",
      "%00.png",
      "%zz.png",
      ".",
    ])
      expect(nameOf("", ref), ref).toBeUndefined()
  })
})

describe("a name's folder and type", () => {
  it("are told by its slashes and its extension", () => {
    expect(folderOf("a/b/c.css")).toBe("a/b")
    expect(folderOf("c.css")).toBe("")
    expect(typeOf("fonts/A.WOFF2")).toBe("font/woff2")
    expect(typeOf("a.svg")).toBe("image/svg+xml")
    expect(typeOf("a.bin")).toBe("application/octet-stream")
  })
})

describe("what a stylesheet names", () => {
  const css = `
    @import "reset.css";
    @import url(theme/dark.css) screen;
    /* url(commented.png) */
    @font-face { font-family: A; src: url("fonts/a.woff2") format("woff2"), url( 'fonts/a.woff' ); }
    .a { background: url(img/a.png) }
    .b { background: url(data:image/png;base64,AAAA) }
    .c { background: url(https://example.com/c.png) }
    .d { background: url(../up.png) }
  `

  it("is each address it writes, but those in comments", () => {
    expect(cssAddresses(css)).toEqual([
      "theme/dark.css",
      "fonts/a.woff2",
      "fonts/a.woff",
      "img/a.png",
      "data:image/png;base64,AAAA",
      "https://example.com/c.png",
      "../up.png",
      "reset.css",
    ])
  })

  it("is the names of those beside the page, each once, from the stylesheet's folder", () => {
    expect(cssNames(css, "")).toEqual([
      "theme/dark.css",
      "fonts/a.woff2",
      "fonts/a.woff",
      "img/a.png",
      "reset.css",
    ])
    expect(cssNames(".a { background: url(a.png) } .b { background: url(a.png) }", "css")).toEqual([
      "css/a.png",
    ])
  })
})
