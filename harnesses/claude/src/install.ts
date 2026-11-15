import { join, win32 } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { scriptInstaller } from "@novadeck/harness-core/installer"

/** Anthropic's own installer, the one its documentation gives for each platform. */
export const installer: Harness["installer"] = (platform) =>
  scriptInstaller(platform, {
    posix: "https://claude.ai/install.sh",
    shell: "bash",
    windows: "https://claude.ai/install.ps1",
  })

/**
 * Where it puts the program: `~/.local/bin/claude` (`claude.exe` on Windows), which a
 * terminal started before the install has not on its PATH; and, from before, its local
 * install in `~/.claude/local`, an alias in the person's rc file rather than on PATH.
 */
export const fallbacks: NonNullable<Harness["fallbacks"]> = ({ home, platform }) =>
  platform === "win32"
    ? [win32.join(home, ".local", "bin", "claude.exe")]
    : [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")]
