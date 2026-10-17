import { relayPath } from "@novadeck/relay"
import { forgetPath, readRegistry, refreshPath } from "@novadeck/terminal/shell"

import { describe, expect, it } from "../test.js"

const windows = process.platform === "win32"

// The terminal library's registry PATH, read through the runner's own relay.
describe("refreshing PATH through the relay", () => {
  it.runIf(windows)("adds the registry's folders to a PATH that lacks them", async () => {
    forgetPath()
    // As Windows spells it, whatever spelling the test runner's own uses.
    const env: NodeJS.ProcessEnv = { Path: "C:\\Nowhere" }
    for (const [name, value] of Object.entries(process.env))
      if (name.toUpperCase() !== "PATH") env[name] = value
    // The product's 5 s read limit is for a user waiting on a terminal, and a cold PowerShell
    // on a loaded runner can pass it (then the PATH rightly stays as it was); this test is
    // about what a read finds, so it waits as long as the sibling reads do.
    const refreshed = await refreshPath(env, { relay: relayPath, timeoutMs: 30_000 })
    const folders = (refreshed.Path ?? "").split(";")
    expect(folders[0]).toBe("C:\\Nowhere")
    expect(folders.length).toBeGreaterThan(1)
    expect(refreshed).not.toHaveProperty("PATH")
    forgetPath()
  })

  it.runIf(windows)("reads the registry through the relay as PowerShell does", async () => {
    const relayed = await readRegistry(process.env, 30_000, relayPath)
    const powershell = await readRegistry(process.env, 30_000)
    expect(Array.isArray(relayed) && relayed.length).toBeGreaterThan(0)
    expect(relayed).toEqual(powershell)
  })
})
