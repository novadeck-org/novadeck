import { describe, expect, it } from "vitest"

import { connectSources } from "./connect-sources.ts"

const api = (url: string | undefined) => ({ url, name: "API_URL" })
const runner = (url: string | undefined) => ({ url, name: "RUNNER_URL" })

describe("connectSources", () => {
  it("allows the page's own origin and loopback HTTP", () => {
    expect(connectSources({ development: false })).toEqual(["'self'", "http://127.0.0.1:*"])
  })

  it("allows a configured remote API's origin", () => {
    expect(connectSources({ api: api("https://api.example.com/v1"), development: false })).toEqual([
      "'self'",
      "http://127.0.0.1:*",
      "https://api.example.com",
    ])
  })

  it("adds nothing for an API on loopback or at a relative path", () => {
    for (const url of ["http://127.0.0.1:8787/api", "/api", "./api", "  "])
      expect(connectSources({ api: api(url), development: false })).toEqual([
        "'self'",
        "http://127.0.0.1:*",
      ])
  })

  it("allows the development server's WebSocket on loopback while served", () => {
    expect(connectSources({ development: true })).toContain("ws://127.0.0.1:*")
  })

  it("rejects an API URL of another protocol, scheme-relative, in backslash form or unreadable", () => {
    for (const url of [
      "ftp://api.example.com",
      "//api.example.com/api",
      "/\\api.example.com/api",
      "//[",
    ])
      expect(() => connectSources({ api: api(url), development: false })).toThrow(
        "API_URL must be an absolute HTTP(S) URL or a relative path",
      )
  })

  it("allows a configured runner's WebSocket origin", () => {
    expect(
      connectSources({ runner: runner("wss://runner.example.com/api/rpc"), development: false }),
    ).toEqual(["'self'", "http://127.0.0.1:*", "wss://runner.example.com"])
  })

  it("rejects a runner URL that is not a WebSocket", () => {
    expect(() =>
      connectSources({ runner: runner("https://runner.example.com"), development: false }),
    ).toThrow("RUNNER_URL must be an absolute ws: or wss: URL")
  })
})
