import { readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Install } from "../harness.js"

/**
 * Antigravity takes its status line only from its user settings, so connecting it puts
 * NovaDeck's there: in NovaDeck's shells it hands the snapshot to NovaDeck's hook, and
 * everywhere it then runs the person's own, which it names. Disconnecting puts theirs back
 * from that name, so nothing beside the settings needs to survive, and another NovaDeck
 * disconnecting it restores it as well. Antigravity itself rewrites this file, so every
 * change reads it afresh and replaces it whole; one it cannot parse is left as it is.
 * Windows keeps the person's own until the command is proven there.
 */

const start = [
  "novadeck_input=$(cat)",
  // A hook that fails leaves the person's status line to decide how it went.
  `if [ -n "$NOVADECK_HOOK" ]; then printf '%s' "$novadeck_input" | "$NOVADECK_HOOK" agy StatusLine >/dev/null 2>&1 || :; fi`,
].join("; ")
const handOff = `; printf '%s' "$novadeck_input" | sh -c `

// A value sh reads back as the same string.
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** NovaDeck's status line, running `own` after it with the same input. */
export const statusLineCommand = (own: string | undefined): string =>
  own ? `${start}${handOff}${quote(own)}` : start

type Settings = { [key: string]: unknown; statusLine?: unknown }
type Line = { [key: string]: unknown; type?: unknown; command?: unknown }

const line = (value: unknown): Line | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : undefined

/**
 * The person's own command a line of NovaDeck's runs: null for none, undefined when the
 * line is not NovaDeck's.
 */
const ownOf = (value: unknown): string | null | undefined => {
  const command = line(value)?.command
  if (typeof command !== "string" || !command.startsWith(start)) return undefined
  if (command === start) return null
  const rest = command.slice(start.length)
  if (!rest.startsWith(handOff)) return undefined
  const own = rest.slice(handOff.length).slice(1, -1).replaceAll("'\\''", "'")
  return statusLineCommand(own) === command ? own : undefined
}

// What NovaDeck's line shows without the person's own.
const added: Record<string, unknown> = { enabled: true, stack_with_default: true }

const settingsFile = (home: string): string => join(home, "settings.json")

// Settings, or undefined when the file holds something else.
const read = async (file: string): Promise<Settings | undefined> => {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  try {
    const settings = JSON.parse(text) as unknown
    return line(settings)
  } catch {
    return undefined
  }
}

// Replaces the file whole, so Antigravity reads the old settings or the new.
const write = async (file: string, value: unknown): Promise<void> => {
  const temporary = `${file}.${process.pid}.novadeck`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export const statusLineSettings = (home: (install: Install) => string) => ({
  apply: async (install: Install): Promise<void> => {
    if (install.platform === "win32") return
    const file = settingsFile(home(install))
    const settings = await read(file)
    if (!settings)
      throw new Error(`${file} is not valid settings. Repair it, then connect Antigravity again.`)
    if (ownOf(settings.statusLine) !== undefined) return
    const own = line(settings.statusLine)
    // Antigravity runs a command whatever its type names, or none.
    const command = typeof own?.command === "string" ? own.command : ""
    // The person's display choices stay; without a status line of their own, Antigravity's
    // default keeps showing above NovaDeck's, which prints nothing.
    settings.statusLine = {
      ...(own ?? added),
      type: "command",
      command: statusLineCommand(command || undefined),
    }
    await write(file, settings)
  },
  // Keeps whatever the person changed of the line meanwhile, and a file it cannot read:
  // NovaDeck's line still runs theirs.
  revert: async (install: Install): Promise<void> => {
    if (install.platform === "win32") return
    const file = settingsFile(home(install))
    const settings = await read(file)
    const own = settings && ownOf(settings.statusLine)
    if (!settings || own === undefined) return
    if (own === null) {
      // Only what NovaDeck added goes; a line the person switched off stays so.
      const { command: _command, type: _type, ...rest } = line(settings.statusLine) ?? {}
      if (Object.entries(rest).every(([key, value]) => value === added[key]))
        delete settings.statusLine
      else settings.statusLine = rest
    } else settings.statusLine = { ...line(settings.statusLine), command: own }
    await write(file, settings)
  },
})

/**
 * Whether Antigravity trusts `cwd`: its settings list it among `trustedWorkspaces`, the
 * same path once normalized, links left unresolved, so another way to the folder isn't
 * taken as trusted and the agent starts plain. A folder inside a trusted one isn't taken
 * as trusted either, which no probe showed. Unreadable settings trust nothing.
 */
export const trustsFolder = async (antigravityHome: string, cwd: string): Promise<boolean> => {
  const settings = await read(settingsFile(antigravityHome)).catch(() => undefined)
  const listed = settings?.trustedWorkspaces
  if (!Array.isArray(listed)) return false
  const here = resolve(cwd)
  return listed.some((folder) => typeof folder === "string" && resolve(folder) === here)
}
