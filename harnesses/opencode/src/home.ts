import { posix, win32 } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"

/** opencode's four folders. */
export type Dirs = {
  readonly data: string
  readonly config: string
  readonly state: string
  readonly cache: string
}

/**
 * Where opencode keeps its files: `<xdg dir>/opencode` for each of the four, whatever the platform
 * (global.ts:9-12 of its core package, 1.19.6, with the `xdg-basedir` package: the variable
 * `XDG_DATA_HOME` and the others where set, else `~/.local/share`, `~/.config`, `~/.local/state` and
 * `~/.cache`, on macOS and Windows too). `install.env` is the person's own environment, which may
 * move them.
 */
export const dirs = ({ env, home, platform }: Pick<Install, "env" | "home" | "platform">): Dirs => {
  const rules = platform === "win32" ? win32 : posix
  const at = (variable: string, ...fallback: string[]): string =>
    rules.join(env[variable] || rules.join(home, ...fallback), "opencode")
  return {
    data: at("XDG_DATA_HOME", ".local", "share"),
    config: at("XDG_CONFIG_HOME", ".config"),
    state: at("XDG_STATE_HOME", ".local", "state"),
    cache: at("XDG_CACHE_HOME", ".cache"),
  }
}

/** Its home, whose presence says it has run: its data folder (sessions, logins, logs). */
export const opencodeHome = (install: Pick<Install, "env" | "home" | "platform">): string =>
  dirs(install).data

export const home = opencodeHome
