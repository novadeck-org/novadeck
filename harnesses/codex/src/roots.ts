import { isAbsolute, resolve } from "node:path"

import { parse } from "smol-toml"

/**
 * The folders the person's own Codex config, in `folder`, lets a workspace-write session write
 * besides its own, `sandbox_workspace_write.writable_roots` at its top level, each as a full path;
 * none where it sets none, or where it doesn't read as TOML (Codex then refuses it too). A
 * relative one is of the config's folder, as Codex reads it there; passed on as it is, it would
 * be read against the session's folder instead (probed 2026-11-17, 0.169.0).
 */
export const theirRoots = (config: string, folder: string): readonly string[] => {
  let parsed: unknown
  try {
    parsed = parse(config)
  } catch {
    return []
  }
  const table = (parsed as { sandbox_workspace_write?: unknown }).sandbox_workspace_write
  const roots = (table as { writable_roots?: unknown } | undefined)?.writable_roots
  return Array.isArray(roots)
    ? roots
        .filter((root): root is string => typeof root === "string")
        .map((root) => (isAbsolute(root) ? root : resolve(folder, root)))
    : []
}

const quote = "'"

/**
 * One folder as a TOML string that holds no double quote, so cmd passes the whole setting in one
 * pair of them and Windows' reading of a command line leaves it whole: a literal one, in single
 * quotes, which keeps a Windows path's backslashes as they are; for a path holding a single quote
 * (`C:\Users\O'Brien`), a multi-line literal one, in three, which takes one or two of them, at
 * its end too (Codex 0.169.0 reads both). A basic one, escaped as JSON escapes it, only for a
 * path no literal can hold: a line break, or three single quotes in a row.
 */
const tomlString = (path: string): string => {
  if (/[\r\n]/.test(path) || path.includes(quote.repeat(3))) return JSON.stringify(path)
  const fence = path.includes(quote) ? quote.repeat(3) : quote
  return `${fence}${path}${fence}`
}

/**
 * The setting that gives a session `roots` to write besides its own folder, a word for `-c`:
 * Codex's `--add-dir` exits when the session's sandbox is read-only ("Ignoring --add-dir …
 * because the effective permissions do not allow additional writable roots", 0.163.0 to at least
 * 0.169.0), where this setting is only unused. A `-c` replaces the config's list, as a profile's
 * does, so the person's own roots go in it too (probed 2026-11-17, 0.169.0,
 * e2e/probes/codex-roots.e2e.ts).
 */
export const rootsSetting = (roots: readonly string[]): string =>
  `sandbox_workspace_write.writable_roots=[${[...new Set(roots)].map(tomlString).join(",")}]`
