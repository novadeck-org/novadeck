import { join, win32 } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { scriptInstaller } from "@novadeck/harness-core/installer"

/** OpenAI's own installer, the one Codex's documentation gives for each platform. */
export const installer: Harness["installer"] = (platform) =>
  scriptInstaller(platform, {
    posix: "https://chatgpt.com/codex/install.sh",
    shell: "sh",
    windows: "https://chatgpt.com/codex/install.ps1",
  })

/**
 * Where it puts the program: the folder `CODEX_INSTALL_DIR` names when the person's
 * environment sets it, else `~/.local/bin`, and on Windows `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`
 * (read from its install.ps1, 2026-11-15).
 */
export const fallbacks: NonNullable<Harness["fallbacks"]> = ({ env, home, platform }) => {
  const custom = env.CODEX_INSTALL_DIR
  if (platform !== "win32") return [join(custom || join(home, ".local", "bin"), "codex")]
  const local = env.LOCALAPPDATA || win32.join(home, "AppData", "Local")
  return [
    win32.join(custom || win32.join(local, "Programs", "OpenAI", "Codex", "bin"), "codex.exe"),
  ]
}
