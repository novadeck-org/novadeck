import { createApp } from "./app.js"
import { describe, expect, it } from "./test.js"

describe("HTTP application", () => {
  it("returns ready status from /api/status", async () => {
    const response = await createApp().request("http://localhost/api/status")

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: "ready" })
  })

  it("returns 404 for unknown API routes", async () => {
    const response = await createApp().request("http://localhost/api/missing")

    expect(response.status).toBe(404)
  })

  it("returns CORS headers for allowed frontend origins", async () => {
    const response = await createApp({
      origins: ["https://app.novadeck.test"],
    }).request("http://localhost/api/status", {
      headers: { Origin: "https://app.novadeck.test" },
    })

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.novadeck.test")
  })

  it("allows the packaged Electron frontend when explicitly configured", async () => {
    const response = await createApp({ origins: ["null"] }).request("http://localhost/api/status", {
      headers: { Origin: "null" },
    })

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("null")
  })

  it("returns 404 for frontend routes", async () => {
    const response = await createApp().request("http://localhost/")

    expect(response.status).toBe(404)
  })
})
