import { hostname } from "node:os"
import { isAbsolute } from "node:path"

const maxPath = 4096

const usable = (path: string): string | undefined =>
  path.length > 0 && path.length <= maxPath && !path.includes("\0") && isAbsolute(path)
    ? path
    : undefined

// Host names compare by their first label: a shell may know the machine by its short
// name and this process by its full one, or the other way round.
const local = (host: string, machine: string): boolean => {
  const name = host.toLowerCase().split(".")[0]
  return !name || name === "localhost" || name === machine.toLowerCase().split(".")[0]
}

/**
 * The directory in an OSC 7 report, `file://host/path` with the path percent-encoded,
 * as bash, zsh and fish send it; undefined when it names another machine, as a shell
 * reached over SSH does, or is not an absolute path here.
 */
export const osc7Directory = (data: string, machine = hostname()): string | undefined => {
  let url: URL
  try {
    url = new URL(data)
  } catch {
    return undefined
  }
  if (url.protocol !== "file:" || !local(url.hostname, machine)) return undefined
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  // A Windows path arrives as /C:/Users/…
  if (process.platform === "win32" && /^\/[A-Za-z]:/.test(path))
    path = path.slice(1).replaceAll("/", "\\")
  return usable(path)
}

/**
 * The directory in an OSC 9;9 report, as PowerShell and cmd send it: the path as it is,
 * perhaps in double quotes. Undefined for other OSC 9 messages, such as notifications.
 */
export const osc9Directory = (data: string): string | undefined => {
  if (!data.startsWith("9;")) return undefined
  const path = data.slice(2)
  const unquoted = path.length >= 2 && path.startsWith('"') && path.endsWith('"')
  return usable(unquoted ? path.slice(1, -1) : path)
}

/**
 * The private OSC a program sends just before it starts another in the terminal's foreground,
 * as Novadeck's shims do for an agent: `OSC 6973 ; launch ; <terminal id> ; <program> ST`. It
 * names the program where the platform names no foreground process (ConPTY names only the
 * shell), and the terminal id says which terminal it was meant for.
 */
export const launchCode = 6973

/** What a launch report says: the terminal it was meant for and the program it starts. */
export type Launch = { readonly terminal: string; readonly program: string }

const launchReport = /^launch;([A-Za-z0-9-]{1,64});([a-z][a-z0-9-]{0,31})$/

/** The launch in an OSC 6973 report's data, after its code; undefined for anything else. */
export const launchOf = (data: string): Launch | undefined => {
  const match = launchReport.exec(data)
  return match ? { terminal: match[1] as string, program: match[2] as string } : undefined
}
