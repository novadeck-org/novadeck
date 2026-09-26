import { startHttpServer } from "./http.js"
import { describe, expect, it } from "./test.js"

describe("HTTP server", () => {
  it("serves the application on an ephemeral port and closes cleanly", async () => {
    const server = await startHttpServer({ port: 0 })

    try {
      const response = await fetch(`${server.origin}/api/status`)

      await expect(response.json()).resolves.toEqual({ status: "ready" })
    } finally {
      await server.close()
    }
  })

  it("returns a bracketed IPv6 origin", async () => {
    const server = await startHttpServer({ hostname: "::1", port: 0 })

    try {
      const url = new URL(server.origin)

      expect(url.hostname).toBe("[::1]")
      await expect(fetch(`${server.origin}/api/status`)).resolves.toMatchObject({ ok: true })
    } finally {
      await server.close()
    }
  })
})
