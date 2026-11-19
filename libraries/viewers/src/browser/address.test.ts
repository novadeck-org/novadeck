import { describe, expect, it } from "vitest"

import { addressOf } from "./address.js"

describe("an address the person typed", () => {
  it("is an http(s) address as it is", () => {
    expect(addressOf("https://example.com/a?b#c")).toBe("https://example.com/a?b#c")
    expect(addressOf("  HTTP://Example.com  ")).toBe("http://example.com/")
  })

  it("goes over https without a scheme", () => {
    expect(addressOf("example.com")).toBe("https://example.com/")
    expect(addressOf("example.com:8443/docs")).toBe("https://example.com:8443/docs")
    expect(addressOf("intranet")).toBe("https://intranet/")
  })

  it("goes over http without a scheme where it's this machine", () => {
    expect(addressOf("localhost:5173/settings")).toBe("http://localhost:5173/settings")
    expect(addressOf("localhost")).toBe("http://localhost/")
    expect(addressOf("app.localhost:3000")).toBe("http://app.localhost:3000/")
    expect(addressOf("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/")
    expect(addressOf("[::1]:4000")).toBe("http://[::1]:4000/")
    expect(addressOf("0.0.0.0:8000")).toBe("http://0.0.0.0:8000/")
  })

  it("is no address with any other scheme", () => {
    for (const typed of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "about:blank",
      "mailto:me@example.com",
      "view-source:https://example.com",
      "chrome://settings",
    ])
      expect(addressOf(typed)).toBeUndefined()
  })

  it("is no address when it's empty or words", () => {
    expect(addressOf("")).toBeUndefined()
    expect(addressOf("   ")).toBeUndefined()
    expect(addressOf("how do I center a div")).toBeUndefined()
    expect(addressOf("//")).toBeUndefined()
  })
})
