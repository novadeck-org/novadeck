import { basename } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"

import { extensionFile } from "./plugin.js"

/**
 * Whether Novadeck's extension is loaded in the pi running in a terminal: its shim adds it with
 * `-e <plugin>/novadeck.mjs`, so a pi started past the shim (by an alias, its own path, or an
 * empty `NOVADECK_SHIMS`) runs without it, and reports nothing. Read from the process's own
 * arguments, which only Linux tells; undefined where they aren't known, as a launch can't be told
 * from one the platform hides.
 */
export const hooksTrusted: NonNullable<Harness["hooksTrusted"]> = async (where) => {
  const { argv } = where
  if (argv === undefined) return undefined
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at]!
    const given =
      word === "-e" || word === "--extension"
        ? argv[at + 1]
        : word.startsWith("--extension=")
          ? word.slice("--extension=".length)
          : undefined
    if (given !== undefined && basename(given.replaceAll("\\", "/")) === extensionFile) return true
  }
  return false
}
