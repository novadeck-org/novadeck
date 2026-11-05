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

  it("rejects a runner whose host a policy can't name as it is", () => {
    // A URL's host may hold these, written or percent-encoded: each would end the page's
    // attribute, start another directive, widen the source or be no source at all.
    for (const url of [
      'wss://a"b.example',
      "wss://a%22b.example",
      "wss://a'b.example",
      "wss://x.example;script-src",
      "wss://a$&b.example",
      "wss://*.example.com",
      "wss://a_b.example",
    ])
      expect(() => connectSources({ runner: runner(url), development: false }), url).toThrow(
        "RUNNER_URL must name its host with letters, digits, dots and hyphens",
      )
  })

  it("allows a runner on an IPv4 or IPv6 address, or on an international name", () => {
    const origin = (url: string) =>
      connectSources({ runner: runner(url), development: false }).at(-1)
    expect(origin("wss://127.0.0.1:9000/rpc")).toBe("wss://127.0.0.1:9000")
    expect(origin("ws://[::1]:8080/rpc")).toBe("ws://[::1]:8080")
    expect(origin("wss://bücher.example")).toBe("wss://xn--bcher-kva.example")
    expect(origin("wss://Runner.Example.com")).toBe("wss://runner.example.com")
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
