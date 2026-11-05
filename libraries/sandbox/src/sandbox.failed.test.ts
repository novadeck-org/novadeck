import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"

import { describe, expect, it, vi } from "vitest"

import { createSandbox } from "./sandbox.js"

// Node's link refused, as Windows refuses one to a user who isn't an administrator and
// hasn't Developer Mode on.
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  symlinkSync: () => {
    throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" })
  },
}))

describe("a sandbox that can't be made", () => {
  it("leaves no folder behind", () => {
    const prefix = `sandbox-failed-${process.pid}-`
    const left = () => readdirSync(tmpdir()).filter((name) => name.startsWith(prefix))

    expect(() => createSandbox({ prefix, bins: [] })).toThrow(
      process.platform === "win32" ? /Developer Mode/ : /EPERM/,
    )
    expect(left()).toEqual([])
  })
})
