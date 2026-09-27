import { contentSecurityPolicyConnectSources } from "./content-security-policy"
import { context, describe, expect, it } from "./test"

describe("frontend Content Security Policy", () => {
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
})
