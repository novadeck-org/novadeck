import { describe, expect, it } from "vitest"

import { configuredSources, connectSources } from "./connect-sources.ts"

const runner = (url: string | undefined) => ({ url, name: "RUNNER_URL" })

describe("connectSources", () => {
  it("allows the page's own origin and loopback HTTP", () => {
    expect(connectSources({ development: false })).toEqual(["'self'", "http://127.0.0.1:*"])
  })

  it("allows the development server's WebSocket on loopback while served", () => {
    expect(connectSources({ development: true })).toContain("ws://127.0.0.1:*")
  })

  it("allows a configured runner's WebSocket origin", () => {
    expect(
      connectSources({ runner: runner("wss://runner.example.com/api/rpc"), development: false }),
    ).toEqual(["'self'", "http://127.0.0.1:*", "wss://runner.example.com"])
  })

  it("adds nothing for a runner left out or blank", () => {
    for (const url of [undefined, "", "  "])
      expect(connectSources({ runner: runner(url), development: false })).toEqual([
        "'self'",
        "http://127.0.0.1:*",
      ])
  })

  it("rejects a runner URL that is not a WebSocket", () => {
    expect(() =>
      connectSources({ runner: runner("https://runner.example.com"), development: false }),
    ).toThrow("RUNNER_URL must be an absolute ws: or wss: URL")
  })
})

describe("configuredSources", () => {
  it("allows the runner the build names, by its variable", () => {
    expect(
      configuredSources({
        command: "build",
        env: { VITE_NOVADECK_RUNNER_URL: " wss://runner.example.com/api/rpc " },
      }),
    ).toEqual(["'self'", "http://127.0.0.1:*", "wss://runner.example.com"])
    expect(() =>
      configuredSources({
        command: "build",
        env: { VITE_NOVADECK_RUNNER_URL: "https://runner.example.com" },
      }),
    ).toThrow("VITE_NOVADECK_RUNNER_URL must be an absolute ws: or wss: URL")
  })

  it("allows the development server's WebSocket only while served", () => {
    expect(configuredSources({ command: "serve", env: {} })).toEqual([
      "'self'",
      "http://127.0.0.1:*",
      "ws://127.0.0.1:*",
    ])
    expect(configuredSources({ command: "build", env: {} })).toEqual([
      "'self'",
      "http://127.0.0.1:*",
    ])
  })
})
