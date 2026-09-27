import { describe, expect, it } from "vitest"

import { devToken, devWebCommands } from "./web.ts"

describe("dev:web", () => {
  it("hands the runner and the UI the same token, each under its own name", () => {
    const [runner, ui] = devWebCommands("a".repeat(64), 9000)
    expect(runner?.env).toEqual({ NOVADECK_TOKEN: "a".repeat(64), PORT: "9000" })
    expect(ui?.env).toEqual({
      VITE_NOVADECK_RUNNER_URL: "ws://127.0.0.1:9000/api/rpc",
      VITE_NOVADECK_RUNNER_TOKEN: "a".repeat(64),
    })
  })

  it("keeps the token out of the runner's other variables", () => {
    const [runner] = devWebCommands("secret-token-for-this-test-only-000000")
    expect(Object.keys(runner?.env ?? {})).not.toContain("VITE_NOVADECK_RUNNER_TOKEN")
  })

  it("makes a new token the runner accepts for every run", () => {
    const [first, second] = [devToken(), devToken()]
    expect(first).not.toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(32)
  })
})
