import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// What step 5's move scripts share: the checks before a run, the handwritten edit and its
// guard, which files are text, and the run's end (install, format, what it left). Each script
// keeps its own table, rewrite and plan. See README.md.

/** The repository at `root`, as a move reads it. */
export const repository = (root: string) => {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
  return {
    git,
    read: (file: string): string => readFileSync(join(root, file), "utf8"),
    tracked: (): string[] => git("ls-files", "-z").split("\0").filter(Boolean),
  }
}

/**
 * Stops the run unless the tree is clean and oxfmt runs; gives the oxfmt to format with, the
 * workspace's own, as `pnpm exec` refuses once the manifests change.
 */
export const preflight = (root: string): string => {
  if (repository(root).git("status", "--porcelain").trim() !== "") {
    console.error("The working tree isn't clean: commit or discard its changes first.")
    process.exit(1)
  }
  const oxfmt = join(root, "node_modules", ".bin", "oxfmt")
  try {
    execFileSync(oxfmt, ["--version"], { cwd: root, stdio: "ignore" })
  } catch {
    console.error("oxfmt can't run here (pnpm install?), and the move formats what it changes.")
    process.exit(1)
  }
  return oxfmt
}

const textual =
  /\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|md|toml|txt|html|css|sh|rs|env|patch|nsh|plist)$|(?:^|\/)\.(?:gitattributes|gitignore|editorconfig|nvmrc)$/

/** Whether a move reads the file at `file` as text. */
export const isText = (file: string): boolean => textual.test(file)

/** A list of paths a move leaves as they are, each with why; a folder ends with `/`. */
export type Kept = readonly { readonly path: string; readonly why: string }[]

/** Whether `kept` keeps the file at `file`. */
export const keeps = (kept: Kept, file: string): boolean =>
  kept.some(({ path }) => file.startsWith(path))

/**
 * A handwritten change a rewrite can't make: `before` becomes `after`, once, or at each place
 * with `all`. It is done once `before` is gone, whatever stands there now, so a second run
 * does nothing and neither does a run after a later move rewrote the line; a file with
 * `before` more than once (without `all`) stops the run. A script's leftover scan is what
 * shows an edit a branch's own change to the line left unmade.
 */
export type Edit = {
  readonly file: string
  readonly before: string
  readonly after: string
  readonly why: string
  readonly all?: boolean
}

/** The file's text with `edit` made, or the problem that stops the run. */
export const applyEdit = (text: string, edit: Edit): { text: string } | { problem: string } => {
  const count = (part: string) => text.split(part).length - 1
  const old = count(edit.before)
  if (old === 0) return { text }
  if (old === 1 || edit.all) return { text: text.split(edit.before).join(edit.after) }
  return {
    problem: `${edit.file}: expected ${JSON.stringify(edit.before)} once (${edit.why}), found it ${old} times`,
  }
}

/**
 * The run's end, once it has moved and written: the lockfile made whole (it names each package
 * by its folder), what it wrote formatted, and the old folders where only ignored files (an
 * install's, a build's) are left, which it names for a person to delete.
 */
export const finish = (options: {
  readonly root: string
  readonly oxfmt: string
  readonly written: readonly string[]
  readonly changed: boolean
  readonly folders: readonly string[]
}): void => {
  const { root, oxfmt, written, changed, folders } = options
  if (changed) {
    execFileSync("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    })
    const formatted = written.filter((file) => /\.(?:[cm]?[jt]sx?|json|ya?ml|md)$/.test(file))
    if (formatted.length > 0) execFileSync(oxfmt, formatted, { cwd: root, stdio: "inherit" })
  }
  const { git } = repository(root)
  const stranded = folders.filter(
    (folder) => existsSync(join(root, folder)) && git("ls-files", folder).trim() === "",
  )
  if (stranded.length > 0)
    console.log(
      `Only ignored files are left in ${stranded.join(", ")}: delete ${stranded.length > 1 ? "them" : "it"} once nothing runs from there.`,
    )
}
