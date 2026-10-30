import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { Resources } from "./resources.js"

describe("resource cleanup", () => {
  it("releases resources in reverse order and aggregates cleanup failures", async () => {
    const resources = new Resources()
    const closed: string[] = []
    const first = new Error("first")
    const second = new Error("second")
    resources.defer(() => {
      closed.push("directory")
    })
    resources.defer(() => {
      closed.push("server")
      throw first
    })
    resources.defer(async () => {
      closed.push("socket")
      throw second
    })
    await expect(resources.dispose()).rejects.toMatchObject({ errors: [second, first] })
    expect(closed).toEqual(["socket", "server", "directory"])
    await expect(resources.dispose()).resolves.toBeUndefined()
    expect(closed).toHaveLength(3)
  })

  it("keeps independently owned resources isolated", async () => {
    const first = new Resources()
    const second = new Resources()
    const closed: string[] = []
    first.defer(() => {
      closed.push("first")
    })
    second.defer(() => {
      closed.push("second")
    })
    await first.dispose()
    expect(closed).toEqual(["first"])
    await second.dispose()
    expect(closed).toEqual(["first", "second"])
  })
})

describe("a cleanup that never ends", () => {
  const forever = () => new Promise<void>(() => {})

  it("fails within its bound, naming what it waited on, and the rest still run", async () => {
    const resources = new Resources({ cleanupMs: 50 })
    const closed: string[] = []
    resources.defer(() => {
      closed.push("directory")
    })
    resources.defer(forever, "the server's close")
    resources.defer(() => forever())
    await expect(resources.dispose()).rejects.toMatchObject({
      errors: [
        { message: "Test cleanup did not end within 50 ms: () => forever()" },
        { message: "Test cleanup did not end within 50 ms: the server's close" },
      ],
    })
    expect(closed).toEqual(["directory"])
  })

  it("fails within its bound while it waits on a timer of the test's fake clock", async () => {
    const resources = new Resources({ cleanupMs: 50 })
    resources.defer(() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)), "a timer")
    vi.useFakeTimers()
    try {
      await expect(resources.dispose()).rejects.toMatchObject({
        errors: [{ message: "Test cleanup did not end within 50 ms: a timer" }],
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
