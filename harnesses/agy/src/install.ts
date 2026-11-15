import { posix, win32 } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { scriptInstaller } from "@novadeck/harness-core/installer"

/** Google's own installer, the one Antigravity's documentation gives for each platform. */
export const installer: Harness["installer"] = (platform) =>
  scriptInstaller(platform, {
    posix: "https://antigravity.google/cli/install.sh",
    shell: "bash",
    windows: "https://antigravity.google/cli/install.ps1",
  })

/**
 * Where it puts the program: `~/.local/bin/agy`, and on Windows
 * `%LOCALAPPDATA%\agy\bin\agy.exe` (read from its install scripts, 2026-11-15).
 */
export const fallbacks: NonNullable<Harness["fallbacks"]> = ({ env, home, platform }) =>
  platform === "win32"
    ? [
        win32.join(
          env.LOCALAPPDATA || win32.join(home, "AppData", "Local"),
          "agy",
          "bin",
          "agy.exe",
        ),
      ]
    : [posix.join(home, ".local", "bin", "agy")]
