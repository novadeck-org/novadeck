import { posix, win32 } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { scriptInstaller } from "@novadeck/harness-core/installer"

// Windows has no script of opencode's own: its documentation gives npm, Scoop and Chocolatey. One
// PowerShell line, run in a PowerShell of its own so it reads the same from cmd and from either
// PowerShell, takes the first of them the machine has, and says so where it has none.
const windows =
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "' +
  "if (Get-Command npm -ErrorAction SilentlyContinue) { npm i -g opencode-ai } " +
  "elseif (Get-Command scoop -ErrorAction SilentlyContinue) { scoop install opencode } " +
  "elseif (Get-Command choco -ErrorAction SilentlyContinue) { choco install opencode -y } " +
  "else { Write-Error 'Install Node.js (npm), Scoop or Chocolatey first, then try again.'; exit 1 }" +
  '"'

/** opencode's own installer on Linux and macOS (https://opencode.ai/install, read 2026-11-22). */
export const installer: Harness["installer"] = (platform) =>
  platform === "win32"
    ? windows
    : scriptInstaller(platform, {
        posix: "https://opencode.ai/install",
        shell: "bash",
        windows: "",
      })

/**
 * Where its installers put the program: its own script, always `~/.opencode/bin/opencode`
 * (install.sh:80, read 2026-11-22), then the places npm, Homebrew, Scoop and Chocolatey link it.
 */
export const fallbacks: NonNullable<Harness["fallbacks"]> = ({ env, home, platform }) => {
  if (platform === "win32") {
    const appData = env.APPDATA || win32.join(home, "AppData", "Roaming")
    return [
      win32.join(home, ".opencode", "bin", "opencode.exe"),
      win32.join(env.NPM_CONFIG_PREFIX || win32.join(appData, "npm"), "opencode.cmd"),
      win32.join(home, "scoop", "shims", "opencode.exe"),
      win32.join(env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin", "opencode.exe"),
    ]
  }
  const npm = env.NPM_CONFIG_PREFIX || env.npm_config_prefix
  return [
    posix.join(home, ".opencode", "bin", "opencode"),
    ...(npm ? [posix.join(npm, "bin", "opencode")] : []),
    ...(platform === "darwin"
      ? ["/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"]
      : ["/home/linuxbrew/.linuxbrew/bin/opencode", "/usr/local/bin/opencode"]),
  ]
}
