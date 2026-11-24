import { access } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"

/**
 * The events Novadeck's extension reports, by the names its hook command gives them: pi has none
 * of its own, so these are the extension's, each from the pi event extension source says.
 */
export const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "SessionLeft",
] as const

/** The file whose presence says Novadeck is connected to pi (`Harness.marker`). */
export const connectedFile = "connected"

/** The extension spawns its hook commands with Node's `shell: true`: `sh`, or `cmd` on Windows. */
export const hookDialect = (platform: NodeJS.Platform): Dialect =>
  platform === "win32" ? "cmd" : "sh"

/** The extension's command for its event, in that shell, printing nothing without Novadeck. */
export const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform), { agent: "pi", event })

/** Whether Novadeck is connected to pi: its marker is in the plugin's folder. */
export const connected: Harness["connected"] = (install) =>
  access(join(install.plugin, connectedFile)).then(
    () => true,
    () => false,
  )

/** The extension's files: none yet (the skeleton). */
export const files: Harness["files"] = () => []
