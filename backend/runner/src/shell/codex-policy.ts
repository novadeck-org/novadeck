import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, isAbsolute } from "node:path"

import { ghVariables, gitVariables } from "./hook.js"

/** Which kinds of variable Codex's configuration sets for its commands, and the hooks never see. */
export type CodexPolicy = { readonly git: boolean; readonly gh: boolean }

/** Both kinds: what a configuration that can't be read or understood is taken to set. */
const both: CodexPolicy = { git: true, gh: true }

// A configuration file is a few lines; one past this is not read.
const maxBytes = 1024 * 1024

/**
 * What a Codex `config.toml` (a layer, or a profile in it) sets for its commands: whether it
 * names, anywhere under `shell_environment_policy` (its `set` table, in any TOML spelling:
 * dotted, inline, quoted), a variable from `gitVariables` or `ghVariables`. This is not a TOML
 * parser: a file that mentions `shell_environment_policy` is searched for the names as text,
 * which no spelling of a table or an inline table escapes, and one that holds a `\u` escape,
 * which could spell a name some other way, counts as naming them all. Names are matched
 * without regard to case, as Windows does.
 */
export const policyOf = (text: string): CodexPolicy => {
  if (!/shell_environment_policy/i.test(text)) return { git: false, gh: false }
  if (/\\[uU]/.test(text)) return both
  const lower = text.toLowerCase()
  const names = (list: readonly string[]) => list.some((name) => lower.includes(name.toLowerCase()))
  return { git: names(gitVariables), gh: names(ghVariables) }
}

/** The system layers Codex reads on Linux and macOS. */
const systemFiles = ["/etc/codex/config.toml", "/etc/codex/managed_config.toml"]

/** Where the layers are read, as a test overrides it. */
export type CodexLayers = {
  /** The user's layer's folder: `CODEX_HOME` as the hook's environment gave it, else `~/.codex`. */
  readonly home?: string | null
  /** The call's folder and the project's, between which every `.codex/config.toml` is a layer. */
  readonly folder?: string | undefined
  readonly project?: string | undefined
  /** The line the terminal launched Codex with: a `-c shell_environment_policy…` there sets one too. */
  readonly command?: string | undefined
  readonly system?: readonly string[]
  readonly userHome?: string
}

// The files to read: system layers, the user's, then each project folder's from the call's up.
const filesOf = ({ home, folder, project, system, userHome }: CodexLayers): string[] => {
  const files = [...(system ?? (process.platform === "win32" ? [] : systemFiles))]
  files.push(join(home || join(userHome ?? homedir(), ".codex"), "config.toml"))
  if (project !== undefined) {
    let at = folder ?? project
    const within = relative(project, at)
    if (within.startsWith("..") || isAbsolute(within)) at = project
    for (;;) {
      files.push(join(at, ".codex", "config.toml"))
      if (at === project || dirname(at) === at) break
      at = dirname(at)
    }
  }
  return files
}

/**
 * What the configuration Codex reads sets for its commands: a variable named under
 * `shell_environment_policy` in the system, the user's or a project's `config.toml` (a profile
 * in any of them included), or in a `-c` on the line it launched with. A file that doesn't exist
 * sets nothing; one that can't be read (a folder, a permission, too large) sets everything.
 * Codex reaches its commands, not its hooks, with these (probed, 0.166.0), so the hook's own
 * environment shows none of them.
 */
export const codexPolicy = async (layers: CodexLayers): Promise<CodexPolicy> => {
  let git = false
  let gh = false
  if (layers.command !== undefined && /shell_environment_policy/i.test(layers.command)) return both
  for (const file of filesOf(layers)) {
    let text: string
    try {
      // eslint-disable-next-line no-await-in-loop -- A few small files, one after the other.
      const buffer = await readFile(file)
      if (buffer.length > maxBytes) return both
      text = buffer.toString("utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") continue
      return both
    }
    const found = policyOf(text)
    git ||= found.git
    gh ||= found.gh
  }
  return { git, gh }
}
