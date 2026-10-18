import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"

// What step 5's move scripts share: the checks before a run, the handwritten edit and its
// guard, which files are text, what is left at an old place once its tracked files moved, and
// the run's end (install, format). Each script keeps its own table, rewrite and plan. See
// README.md.

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
 * workspace's own, as `pnpm exec` refuses once the manifests change. Files git doesn't track
 * are allowed in `folders`, the old places: a package's own `.gitignore` covered them until a
 * merge moved it with the package, and the move carries them to the new place.
 */
export const preflight = (root: string, folders: readonly string[]): string => {
  const dirty = repository(root)
    .git("status", "--porcelain", "-z", "--untracked-files=all")
    .split("\0")
    .filter(Boolean)
    .filter(
      (line) =>
        !(
          line.startsWith("?? ") && folders.some((folder) => line.slice(3).startsWith(`${folder}/`))
        ),
    )
  if (dirty.length > 0) {
    console.error(
      `The working tree isn't clean: commit or discard its changes first.\n${dirty.slice(0, 20).join("\n")}`,
    )
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
  /\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|md|toml|txt|html|css|sh|ps1|rs|env|patch|nsh|plist|svg|xml)$|(?:^|\/)(?:\.gitattributes|\.gitignore|\.editorconfig|\.nvmrc|CODEOWNERS|Dockerfile)$/

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
 * `before` more than once (without `all`) stops the run.
 */
export type Edit = {
  readonly file: string
  readonly before: string
  readonly after: string
  readonly why: string
  readonly all?: boolean
}

/**
 * The file's text with `edit` made, and whether it was `made` now, `there` already, or `gone`
 * (neither its old text nor its new: a person changed the line, and the edit has nothing to
 * do); or the problem that stops the run.
 */
export const applyEdit = (
  text: string,
  edit: Edit,
): { text: string; state: "made" | "there" | "gone" } | { problem: string } => {
  const count = (part: string) => text.split(part).length - 1
  const old = count(edit.before)
  // An edit that removes its text is made once that text is gone.
  if (old === 0)
    return { text, state: edit.after === "" || count(edit.after) > 0 ? "there" : "gone" }
  if (old === 1 || edit.all)
    return { text: text.split(edit.before).join(edit.after), state: "made" }
  return {
    problem: `${edit.file}: expected ${JSON.stringify(edit.before)} once (${edit.why}), found it ${old} times`,
  }
}

/** The tracked files whose place, old or new, a package's `.gitignore` ignores: build output. */
export const trackedIgnored = (root: string, places: readonly string[]): readonly string[] => {
  if (places.length === 0) return []
  try {
    return execFileSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
      cwd: root,
      encoding: "utf8",
      input: places.join("\0"),
    })
      .split("\0")
      .filter(Boolean)
  } catch {
    // check-ignore exits 1 when it ignores none.
    return []
  }
}

/** The places of `destinations` no `packages:` glob of pnpm-workspace.yaml takes in. */
export const outsideWorkspace = (root: string, destinations: readonly string[]): string[] => {
  const globs = [
    ...readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").matchAll(/^ {2}- (.+)$/gm),
  ].map(([, glob]) => glob!.trim().replace(/^["']|["']$/g, ""))
  return destinations.filter(
    (place) => !globs.some((glob) => glob === place || glob === `${dirname(place)}/*`),
  )
}

// What a build or an install leaves, which the next one makes again.
const regenerated = new Set(["node_modules", "dist", "target", ".turbo"])

/**
 * Empties each old folder in `folders` once no tracked file is left there, so nothing is lost
 * and nothing is committed at an old place: a file git doesn't track (a `.env`, build output a
 * package's own `.gitignore` covers) goes to its place in the package's new folder, by
 * `destinationOf`; an install's or a build's folders go where the new one has none, and are
 * deleted where it has. A file whose new place holds another stays, and is given back.
 */
export const carry = (
  root: string,
  folders: readonly string[],
  destinationOf: (file: string) => string | undefined,
): { carried: string[]; clashes: string[] } => {
  const { git } = repository(root)
  const carried: string[] = []
  const clashes: string[] = []
  const visit = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const from = `${path}/${entry.name}`
      const to = destinationOf(from)!
      if (entry.isDirectory() && regenerated.has(entry.name)) {
        if (entry.name !== "node_modules" && !existsSync(join(root, to))) {
          mkdirSync(join(root, dirname(to)), { recursive: true })
          renameSync(join(root, from), join(root, to))
        } else rmSync(join(root, from), { recursive: true, force: true })
      } else if (entry.isDirectory()) visit(from)
      else if (!existsSync(join(root, to))) {
        mkdirSync(join(root, dirname(to)), { recursive: true })
        renameSync(join(root, from), join(root, to))
        carried.push(`${from} -> ${to}`)
      } else if (readFileSync(join(root, from)).equals(readFileSync(join(root, to))))
        rmSync(join(root, from))
      else clashes.push(`${from} (${to} holds another)`)
    }
  }
  for (const folder of folders) {
    if (!existsSync(join(root, folder)) || git("ls-files", folder).trim() !== "") continue
    visit(folder)
    // Folders left empty, deepest first.
    const empty = (path: string): boolean => {
      const full = join(root, path)
      if (!statSync(full).isDirectory()) return false
      const all = readdirSync(full).map((name) => empty(`${path}/${name}`))
      if (all.every(Boolean)) rmSync(full, { recursive: true, force: true })
      return all.every(Boolean)
    }
    empty(folder)
  }
  return { carried, clashes: clashes.map((clash) => relative(".", clash)) }
}

/**
 * The run's end: the lockfile made whole, on every run, as it names each package by its
 * folder and a catch-up may have taken main's; and what the run wrote formatted.
 */
export const finish = (root: string, oxfmt: string, written: readonly string[]): void => {
  execFileSync("pnpm", ["install", "--no-frozen-lockfile"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  })
  const formatted = written.filter((file) => /\.(?:[cm]?[jt]sx?|json|ya?ml|md)$/.test(file))
  if (formatted.length > 0) execFileSync(oxfmt, formatted, { cwd: root, stdio: "inherit" })
}
