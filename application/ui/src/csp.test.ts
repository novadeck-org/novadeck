import { readFileSync } from "node:fs"
import { join } from "node:path"

import { contentSecurityPolicyConnectSources } from "./content-security-policy"
import { context, describe, expect, it } from "./test"

describe("frontend Content Security Policy", () => {
  it("runs only same-origin script files, so the theme's boot script is one too", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8")
    expect(html).toContain("script-src 'self';")
    expect(html).toContain('<script src="./theme-boot.js"></script>')
    // Every script has a source; none is inline.
    expect([...html.matchAll(/<script\b[^>]*>/g)].every(([tag]) => tag.includes(" src="))).toBe(
      true,
    )
  })

  context("for a standalone production build", () => {
    it("allows only the configured remote API origin", () => {
      expect(contentSecurityPolicyConnectSources("https://api.example.com/v1", false)).toEqual([
        "'self'",
        "http://127.0.0.1:*",
        "https://api.example.com",
      ])
    })
  })

  context("during local development", () => {
    it("allows the Vite WebSocket on loopback", () => {
      expect(contentSecurityPolicyConnectSources(undefined, true)).toContain("ws://127.0.0.1:*")
    })
  })

  context("when the API URL uses an unsupported protocol", () => {
    it("rejects the build configuration", () => {
      expect(() => contentSecurityPolicyConnectSources("ftp://api.example.com", false)).toThrow(
        "VITE_API_URL must be an absolute HTTP(S) URL or a relative path",
      )
    })
  })

  context("when the API URL is scheme-relative", () => {
    it("rejects the build configuration", () => {
      expect(() => contentSecurityPolicyConnectSources("//api.example.com/api", false)).toThrow(
        "VITE_API_URL must be an absolute HTTP(S) URL or a relative path",
      )
    })

    it("rejects a backslash-form URL", () => {
      expect(() => contentSecurityPolicyConnectSources("/\\api.example.com/api", false)).toThrow(
        "VITE_API_URL must be an absolute HTTP(S) URL or a relative path",
      )
    })
  })

  context("when a browser build names its runner", () => {
    it("allows the runner's WebSocket origin", () => {
      expect(
        contentSecurityPolicyConnectSources(undefined, false, "wss://runner.example.com/api/rpc"),
      ).toEqual(["'self'", "http://127.0.0.1:*", "wss://runner.example.com"])
    })

    it("rejects a runner URL that is not a WebSocket", () => {
      expect(() =>
        contentSecurityPolicyConnectSources(undefined, false, "https://runner.example.com"),
      ).toThrow("VITE_NOVADECK_RUNNER_URL must be an absolute ws: or wss: URL")
    })
  })
})
