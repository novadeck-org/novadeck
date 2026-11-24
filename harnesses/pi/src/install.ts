import { posix, win32 } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { scriptInstaller } from "@novadeck/harness-core/installer"

/**
 * pi's own installer (https://pi.dev/install.sh and install.ps1, read 2026-11-24): it needs Node and
 * may ask questions, which Novadeck's visible install terminal lets the person answer.
 */
export const installer: Harness["installer"] = (platform) =>
  scriptInstaller(platform, {
    posix: "https://pi.dev/install.sh",
    shell: "sh",
    windows: "https://pi.dev/install.ps1",
  })

/**
 * Where its installers put the program when it is not on PATH: its managed launcher
 * (`~/.pi/agent/bin`), then the folders its script falls back to, and npm's prefix.
 */
export const fallbacks: NonNullable<Harness["fallbacks"]> = ({ env, home, platform }) => {
  if (platform === "win32") {
    const appData = env.APPDATA || win32.join(home, "AppData", "Roaming")
    return [
      win32.join(home, ".pi", "agent", "bin", "pi.cmd"),
      win32.join(env.NPM_CONFIG_PREFIX || win32.join(appData, "npm"), "pi.cmd"),
    ]
  }
  const npm = env.NPM_CONFIG_PREFIX || env.npm_config_prefix
  return [
    posix.join(home, ".pi", "agent", "bin", "pi"),
    posix.join(home, ".local", "bin", "pi"),
    posix.join(home, "bin", "pi"),
    posix.join(home, ".bin", "pi"),
    ...(npm ? [posix.join(npm, "bin", "pi")] : []),
  ]
}
