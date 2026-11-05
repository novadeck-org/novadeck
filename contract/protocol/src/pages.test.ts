import { describe, expect, it } from "vitest"

import { onThisMachine, pageKey } from "./pages.js"

// Item keys are kept in the workspace, so a change here needs a migration of them.
describe("a page's key", () => {
  it("is one per server on this machine, whatever its route, query or name for the machine", () => {
    const key = "http://localhost:5173"
    expect(pageKey("http://localhost:5173/settings?tab=2#top")).toBe(key)
    expect(pageKey("http://127.0.0.1:5173/")).toBe(key)
    expect(pageKey("http://[::1]:5173/x")).toBe(key)
    expect(pageKey("http://0.0.0.0:5173")).toBe(key)
    expect(pageKey("http://[::]:5173")).toBe(key)
  })

  it("tells this machine's servers apart by port and scheme", () => {
    expect(pageKey("http://localhost:3000/a")).toBe("http://localhost:3000")
    expect(pageKey("https://localhost/a")).toBe("https://localhost")
  })

  it("is any other page's address without its fragment", () => {
    expect(pageKey("https://example.com/docs?q=1#intro")).toBe("https://example.com/docs?q=1")
  })

  it("is an address that isn't one as given", () => {
    expect(pageKey("not a url")).toBe("not a url")
  })
})

describe("a page on this machine", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1/", "http://[::1]:8080/x", "http://0.0.0.0"])(
    "is %s",
    (address) => {
      expect(onThisMachine(address)).toBe(true)
    },
  )

  it.each(["https://example.com", "http://192.168.1.4:3000", "not a url", "file:///tmp/a.html"])(
    "is not %s",
    (address) => {
      expect(onThisMachine(address)).toBe(false)
    },
  )
})
