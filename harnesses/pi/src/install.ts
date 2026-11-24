import { posix, win32 } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { scriptInstaller } from "@novadeck/harness-core/installer"

import { agentDir } from "./home.js"

/**
 * pi's own installer (https://pi.dev/install.sh and install.ps1, read 2026-11-24), as its docs give
 * it. It needs Node 22.19 or newer and npm, and offers to install Node where there is none (with
 * brew, apt or apk, or a download); on Windows it offers Git for Windows too, which pi's bash tool
 * needs. It asks before it installs, may offer to put its folder on PATH, and ends asking whether
 * to start pi: the visible install terminal lets the person answer.
 */
export const installer: Harness["installer"] = (platform) =>
  scriptInstaller(platform, {
    posix: "https://pi.dev/install.sh",
    shell: "sh",
    windows: "https://pi.dev/install.ps1",
  })

/**
 * Where its installers put the program when it is not on PATH (install.sh and install.ps1, read
 * 2026-11-24): the managed install's launcher, in the agent folder's `bin`, or in the first of
 * these on PATH it may write to: `~/.local/bin`, `~/bin`, `~/.bin`, `~/local/bin`, Homebrew's bin;
 * npm's global prefix for `npm install -g` (the script's own fallback is the prefix `~/.local`);
 * Homebrew's formula (`pi-coding-agent`); a Nix profile. On Windows the managed launcher and
 * npm's shims are `pi.cmd`. A `pi` in one of them may be another program of that name (Ubuntu's
 * `pi` prints digits of π), so whoever runs one asks its version first (`versionOf`).
 */
export const fallbacks: NonNullable<Harness["fallbacks"]> = ({ env, home, platform }) => {
  if (platform === "win32") {
    const appData = env.APPDATA || win32.join(home, "AppData", "Roaming")
    return [
      win32.join(agentDir({ env, home, platform }), "bin", "pi.cmd"),
      win32.join(env.NPM_CONFIG_PREFIX || win32.join(appData, "npm"), "pi.cmd"),
    ]
  }
  const npm = env.NPM_CONFIG_PREFIX || env.npm_config_prefix
  return [
    posix.join(agentDir({ env, home, platform }), "bin", "pi"),
    posix.join(home, ".local", "bin", "pi"),
    posix.join(home, "bin", "pi"),
    posix.join(home, ".bin", "pi"),
    posix.join(home, "local", "bin", "pi"),
    ...(npm ? [posix.join(npm, "bin", "pi")] : []),
    ...(platform === "darwin"
      ? ["/opt/homebrew/bin/pi", "/usr/local/bin/pi"]
      : ["/home/linuxbrew/.linuxbrew/bin/pi", "/usr/local/bin/pi"]),
    posix.join(home, ".nix-profile", "bin", "pi"),
  ]
}
