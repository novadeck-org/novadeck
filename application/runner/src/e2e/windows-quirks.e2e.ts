import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "../test.js"
import { createDeck } from "./deck.js"

// What Windows CI's quirks job sets up on its runner, which no test may on a developer's
// machine: a folder holding `novadeck-registry-marker.cmd` that the user's PATH in the
// registry gained after the job's runner started, so no process of the job has it on its
// own PATH (NOVADECK_E2E_REGISTRY_FOLDER names it).
const folder = process.env.NOVADECK_E2E_REGISTRY_FOLDER

/** `env` without `folder` on its PATH, whatever spells it, as the job's processes have it. */
const without = (env: NodeJS.ProcessEnv, gone: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) => {
      if (value === undefined) return []
      if (name.toUpperCase() !== "PATH") return [[name, value]]
      const kept = value.split(";").filter((each) => each.toLowerCase() !== gone.toLowerCase())
      return [[name, kept.join(";")]]
    }),
  )

describe.runIf(process.platform === "win32" && folder !== undefined)("a Windows terminal", () => {
  it("finds a program the registry's PATH gained after the app started", async () => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-e2e-registry-"))
    // No harness runs here, so the registry's folders may join the terminal's PATH.
    const deck = await createDeck({
      data: join(root, "data"),
      project: root,
      env: without(process.env, folder!),
      freshPath: true,
    })
    try {
      const terminal = await deck.open("novadeck-registry-marker")
      await terminal.until("registry marker ran", 30_000)
    } finally {
      await deck.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  })
})
