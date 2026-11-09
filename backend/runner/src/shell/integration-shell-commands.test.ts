import { existsSync } from "node:fs"

import { describe, expect } from "../test.js"
import { bash, it } from "./integration.test-support.js"
import { ringing } from "./stand-ins.test-support.js"

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "a command run in an agent's shell mode",
  () => {
    it("shows the terminal running it, then idle once it ends, with no turn", async ({ shell }) => {
      // Codex before its first prompt: nothing is bound, only its box is shown; no turn starts.
      const tui = await ringing(shell, "shellmode", "tui", "codex")
      const summary = () => tui.manager.get(tui.idle.id)
      expect(summary().shellCommand).toBeNull()
      tui.type("!")
      await shell.until(tui.manager, tui.idle.id, "! ")
      tui.type("sleep 4")
      await shell.until(tui.manager, tui.idle.id, "! sleep 4")
      const before = Date.now()
      tui.type("\r")
      await expect.poll(() => summary().shellCommand?.command, { timeout: 10_000 }).toBe("sleep 4")
      expect(summary().shellCommand?.since).toBeGreaterThanOrEqual(before)
      expect(summary().activity?.state ?? "idle").toBe("idle")
      await expect.poll(() => summary().shellCommand, { timeout: 15_000 }).toBeNull()
      expect(summary().activity?.state ?? "idle").toBe("idle")
    })

    it("shows nothing for a message typed in the prompt", async ({ shell }) => {
      const tui = await ringing(shell, "shellmode", "tui", "codex")
      tui.type("sleep 4")
      await shell.until(tui.manager, tui.idle.id, "› sleep 4")
      tui.type("\r")
      await new Promise((resolve) => setTimeout(resolve, 3_500))
      expect(tui.manager.get(tui.idle.id).shellCommand).toBeNull()
    })
  },
)
