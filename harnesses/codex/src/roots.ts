import { parse } from "smol-toml"

/**
 * The folders the person's own Codex config lets a workspace-write session write besides its
 * own, `sandbox_workspace_write.writable_roots` at its top level; none where it sets none, or
 * where it doesn't read as TOML (Codex then refuses it too).
 */
export const theirRoots = (config: string): readonly string[] => {
  let parsed: unknown
  try {
    parsed = parse(config)
  } catch {
    return []
  }
  const table = (parsed as { sandbox_workspace_write?: unknown }).sandbox_workspace_write
  const roots = (table as { writable_roots?: unknown } | undefined)?.writable_roots
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : []
}

/**
 * One folder as a TOML string: a literal one, in single quotes, which keeps a Windows path's
 * backslashes as they are and holds no double quote, so cmd passes the whole setting quoted;
 * a basic one, escaped as JSON escapes it, for a path holding a single quote or a line break.
 */
const tomlString = (path: string): string =>
  /['\r\n]/.test(path) ? JSON.stringify(path) : `'${path}'`

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
