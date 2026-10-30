import { spawnSync } from "node:child_process"

const windows = process.platform === "win32"

// Windows' names are any case, as is how a program writes them; Linux's are one.
export const fold = (text: string): string => (windows ? text.toLowerCase() : text)

// Each character past ASCII as JSON's `\uXXXX`, in either case of hex, as some programs
// write JSON.
const escaped = (text: string): readonly string[] =>
  [(hex: string) => hex, (hex: string) => hex.toUpperCase()].map((cased) =>
    text.replaceAll(
      /[\u0080-￿]/g,
      (character) => `\\u${cased(character.charCodeAt(0).toString(16).padStart(4, "0"))}`,
    ),
  )

/**
 * The ways a configuration file may write a path: as it is, as JSON or TOML escape it
 * (`C:\\Users\\…`, as Windows paths are written there), with each character past ASCII
 * as `\uXXXX` too, with forward slashes (`C:/Users/…`), and as MSYS writes one
 * (`/c/Users/…`), as some programs write a Windows path. On Linux all are the path
 * itself, or its escapes.
 */
export const spellings = (path: string): readonly string[] => {
  const json = JSON.stringify(path).slice(1, -1)
  const forward = path.replaceAll("\\", "/")
  const drive = /^([a-z]):\//i.exec(forward)
  return [
    ...new Set([
      path,
      json,
      ...escaped(json),
      forward,
      ...(drive ? [`/${drive[1]!.toLowerCase()}/${forward.slice(3)}`] : []),
    ]),
  ]
}

/**
 * The path's 8.3 short name (`C:\Users\JANKOW~1\…`), as Windows keeps one on most volumes
 * and a program may write a path that would need quoting by it, or undefined
 * where it has none other than the path itself, or off Windows.
 */
export const shortName = (path: string): string | undefined => {
  if (!windows) return undefined
  // Verbatim, as Node would escape the inner quotes in a way cmd does not read; `/u`
  // prints UTF-16, which keeps a name past ASCII that a console code page would not.
  const { status, stdout } = spawnSync(
    process.env.ComSpec || "cmd.exe",
    ["/d", "/u", "/s", "/c", `"for %A in ("${path}") do @echo %~sA"`],
    { windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000 },
  )
  if (status !== 0 || !stdout) return undefined
  const short = stdout.toString("utf16le").trim()
  return short !== "" && fold(short) !== fold(path) ? short : undefined
}
