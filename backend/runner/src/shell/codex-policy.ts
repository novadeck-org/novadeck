import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative, isAbsolute } from "node:path"

import { ghComparedVariables, ghVariables, gitComparedVariables, gitVariables } from "./hook.js"

/** What Codex's configuration sets for its commands, which its hooks never see. */
export type CodexPolicy = {
  /** A variable that redirects or extends git. */
  readonly git: boolean
  /** A variable that redirects or extends gh. */
  readonly gh: boolean
  /** A `PATH`: the commands' is then not the hook's, and nothing is known of what they run. */
  readonly path: boolean
}

/** Everything: what a configuration that can't be read is taken to set. */
const all: CodexPolicy = { git: true, gh: true, path: true }
const none: CodexPolicy = { git: false, gh: false, path: false }

// A configuration file is a few lines; one past this is not read.
const maxBytes = 1024 * 1024

const escapes: { readonly [char: string]: string } = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
}

/**
 * The text with every TOML escape decoded (`\xHH`, `\uXXXX`, `\UXXXXXXXX`, `\e` and the
 * standard ones; TOML 1.1, which Codex's reader accepts, has the first and the fourth), so a name
 * or a table written with them reads as itself. It decodes inside literal strings too, where a
 * backslash is a backslash: a name found there can only add a refusal. A line-ending backslash
 * joins its lines.
 */
const decoded = (text: string): string =>
  text
    .replaceAll(/\\\r?\n\s*/g, "")
    .replaceAll(
      /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|(["\\btnfre]))/g,
      (whole, x?: string, u?: string, big?: string, plain?: string) => {
        const code = x ?? u ?? big
        if (code === undefined) return escapes[plain as string] ?? whole
        const point = Number.parseInt(code, 16)
        return point <= 0x10ffff ? String.fromCodePoint(point) : whole
      },
    )

// A variable set under `shell_environment_policy` is a key: `NAME =` (bare, quoted, or the last of a
// dotted key), whatever the table or inline table round it.
const named = (text: string, names: readonly string[]): boolean =>
  names.some((name) => new RegExp(`(?<![A-Za-z0-9_])${name}["']?[ \\t]*=`, "i").test(text))

/**
 * What a Codex `config.toml` (a layer, or a profile in it) sets for its commands: whether it
 * names, as a key anywhere in a file that has a `shell_environment_policy` (its `set` table, in
 * any TOML spelling: dotted, inline, quoted), a variable from the git or gh lists or a `PATH`. This
 * is not a TOML parser (none is in the repo's dependencies): after decoding every escape, the text is
 * searched for the table's name and the keys, which no spelling of a table or an inline table escapes.
 * Names match without regard to case, as Windows reads them.
 */
export const policyOf = (raw: string): CodexPolicy => {
  const text = decoded(raw)
  if (!/shell_environment_policy/i.test(text)) return none
  return {
    git: named(text, [...gitVariables, ...gitComparedVariables]),
    gh: named(text, [...ghVariables, ...ghComparedVariables]),
    path: named(text, ["PATH"]),
  }
}

/** The system layers Codex reads on Linux and macOS. */
const systemFiles = ["/etc/codex/config.toml", "/etc/codex/managed_config.toml"]

/** Where the layers are read, as a test overrides it. */
export type CodexLayers = {
  /** The user's layer's folder: `CODEX_HOME` as the hook's environment gave it, else `~/.codex`. */
  readonly home?: string | null
  /** The call's folder and the project's: every `.codex/config.toml` from there up to the root is a layer. */
  readonly folder?: string | undefined
  readonly project?: string | undefined
  /** The line the terminal launched Codex with: a `-c shell_environment_policy…` there sets one too. */
  readonly command?: string | undefined
  readonly system?: readonly string[]
  readonly userHome?: string
}

// The files to read: system layers, the user's, then each folder's from the call's up to the root.
const filesOf = ({ home, folder, project, system, userHome }: CodexLayers): string[] => {
  const files = [...(system ?? (process.platform === "win32" ? [] : systemFiles))]
  files.push(join(home || join(userHome ?? homedir(), ".codex"), "config.toml"))
  if (project !== undefined) {
    let at = folder ?? project
    const within = relative(project, at)
    if (within.startsWith("..") || isAbsolute(within)) at = project
    // Codex reads a layer from each folder up to its project root marker (`.git`) and the
    // marker may be above the project folder: so up to the filesystem root.
    for (;;) {
      files.push(join(at, ".codex", "config.toml"))
      if (dirname(at) === at) break
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
 * The walk goes up to the filesystem root, as the project root marker may be anywhere above.
 * Codex reaches its commands, not its hooks, with these (probed, 0.166.0), so the hook's own
 * environment shows none of them.
 */
export const codexPolicy = async (layers: CodexLayers): Promise<CodexPolicy> => {
  let git = false
  let gh = false
  let path = false
  if (layers.command !== undefined && /shell_environment_policy/i.test(decoded(layers.command)))
    return all
  for (const file of filesOf(layers)) {
    let text: string
    try {
      // eslint-disable-next-line no-await-in-loop -- A few small files, one after the other.
      const buffer = await readFile(file)
      if (buffer.length > maxBytes) return all
      text = buffer.toString("utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") continue
      return all
    }
    const found = policyOf(text)
    git ||= found.git
    gh ||= found.gh
    path ||= found.path
  }
  return { git, gh, path }
}
