import { execFileSync } from "node:child_process"
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs"
import { dirname, join } from "node:path"

// What step 5's move scripts share: the checks before a run, the handwritten edit and its
// guard, which files are text, what is left at an old place once its tracked files moved, a
// rename on a branch that a move undid, and the run's end (install, format). Each script
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
 * What keeps the tree from counting as clean: every change git sees, but files it doesn't
 * track in `folders`, the old places. A package's own `.gitignore` covered those until a merge
 * moved it with the package, and the move carries them to the new place.
 */
export const dirt = (root: string, folders: readonly string[]): string[] =>
  repository(root)
    .git("status", "--porcelain", "-z", "--untracked-files=all")
    .split("\0")
    .filter(Boolean)
    .filter(
      (line) =>
        !(
          line.startsWith("?? ") && folders.some((folder) => line.slice(3).startsWith(`${folder}/`))
        ),
    )

/**
 * Stops the run unless the tree is clean (see `dirt`) and oxfmt runs; gives the oxfmt to
 * format with, the workspace's own, as `pnpm exec` refuses once the manifests change.
 */
export const preflight = (root: string, folders: readonly string[]): string => {
  const dirty = dirt(root, folders)
  if (dirty.length > 0) {
    console.error(
      `The working tree isn't clean: commit or discard its changes first. A file you placed at a new place by hand while merging needs \`git add\`.\n${dirty.slice(0, 20).join("\n")}`,
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
  /\.(?:[cm]?[jt]sx?|json|jsonc|ya?ml|md|toml|txt|html|css|sh|ps1|py|cs|rs|env|patch|nsh|plist|svg|xml)$|(?:^|\/)(?:\.gitattributes|\.gitignore|\.editorconfig|\.nvmrc|\.npmrc|CODEOWNERS|Dockerfile|Makefile)$/

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
  /** Forms main gave the line after the move, which count as the edit there, not a change. */
  readonly settled?: readonly string[]
  /**
   * Where a later step's move took the file: once it is gone from `file`, the edit reads it
   * there, where `settled` holds the form that move gave the line.
   */
  readonly later?: string
}

/**
 * The file's text with `edit` made, and whether it was `made` now, `there` already, or `gone`
 * (neither its old text nor its new: a person changed the line, and the edit has nothing to
 * do); or the problem that stops the run. An edit that removes its text is `there` once the
 * text is gone, and so is one whose line holds a form in `settled`.
 */
export const applyEdit = (
  text: string,
  edit: Edit,
): { text: string; state: "made" | "there" | "gone" } | { problem: string } => {
  const count = (part: string) => text.split(part).length - 1
  const old = count(edit.before)
  if (old === 0) {
    const there =
      edit.after === "" ||
      count(edit.after) > 0 ||
      (edit.settled ?? []).some((form) => count(form) > 0)
    return { text, state: there ? "there" : "gone" }
  }
  if (old === 1 || edit.all)
    return { text: text.split(edit.before).join(edit.after), state: "made" }
  return {
    problem: `${edit.file}: expected ${JSON.stringify(edit.before)} once (${edit.why}), found it ${old} times`,
  }
}

/** The places among `places` that a `.gitignore` ignores, as it stands or wherever it moves. */
export const ignoredPlaces = (root: string, places: readonly string[]): readonly string[] => {
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

/**
 * On a branch whose last commit is the merge that brought a move in from main: the files the
 * branch removed or renamed at an old place that the merge brought back at their new place
 * from main's side, while the branch's renamed copy is there too, or the branch had deleted
 * them. `marker` is a file the move takes from `from` to `to`, which tells the merge apart.
 * Once a later commit settles it (`git rm` of one, or an empty commit keeping main's), the
 * check is off: it is the recipe's next step, and only then.
 */
export const undoneByMerge = (options: {
  readonly root: string
  readonly marker: { readonly from: string; readonly to: string }
  readonly olds: readonly string[]
  readonly destinationOf: (file: string) => string | undefined
}): { readonly back: string; readonly file: string; readonly renamed?: string }[] => {
  const { root, marker, olds, destinationOf } = options
  const { git, tracked } = repository(root)
  const has = (commit: string, file: string): boolean => {
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}:${file}`], { cwd: root, stdio: "ignore" })
      return true
    } catch {
      return false
    }
  }
  const parents = git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").slice(1)
  if (parents.length !== 2 || !has("HEAD^1", marker.from) || !has("HEAD^2", marker.to)) return []
  const base = git("merge-base", "HEAD^1", "HEAD^2").trim()
  const present = new Set(tracked())
  return git("diff", "--name-status", "-M", "--diff-filter=DR", base, "HEAD^1", "--", ...olds)
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [status, file, renamed] = line.split("\t") as [string, string, string | undefined]
      const back = destinationOf(file)
      if (back === undefined || !present.has(back)) return []
      if (status.startsWith("R")) {
        // Only while both stand: the branch's copy, at its old or new place, and main's.
        const copy = [renamed!, destinationOf(renamed!)].find(
          (place) => place && present.has(place),
        )
        return copy ? [{ back, file, renamed: copy }] : []
      }
      return [{ back, file }]
    })
}

const exists = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const same = (a: string, b: string): boolean => {
  const [left, right] = [lstatSync(a), lstatSync(b)]
  if (left.isSymbolicLink() || right.isSymbolicLink())
    return left.isSymbolicLink() && right.isSymbolicLink() && readlinkSync(a) === readlinkSync(b)
  return left.isFile() && right.isFile() && readFileSync(a).equals(readFileSync(b))
}

// What a build or an install leaves, which the next one makes again.
const regenerated = new Set(["node_modules", "dist", "target", ".turbo"])

/**
 * Empties each old folder in `folders` once no tracked file is left there, so nothing is lost
 * and nothing is committed at an old place: a file git doesn't track (a `.env`, build output a
 * package's own `.gitignore` covers, a symbolic link) goes to its place in the package's new
 * folder, by `destinationOf`; an install's or a build's folders go where the new one has none,
 * and are deleted where it has. A file whose new place holds another stays, and is given back.
 */
export const carry = (
  root: string,
  folders: readonly string[],
  destinationOf: (file: string) => string | undefined,
): { carried: { from: string; to: string }[]; clashes: string[] } => {
  const { git } = repository(root)
  const carried: { from: string; to: string }[] = []
  const clashes: string[] = []
  const move = (from: string, to: string) => {
    mkdirSync(join(root, dirname(to)), { recursive: true })
    renameSync(join(root, from), join(root, to))
  }
  const visit = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const from = `${path}/${entry.name}`
      const to = destinationOf(from)!
      const taken = exists(join(root, to))
      if (entry.isDirectory() && regenerated.has(entry.name)) {
        if (entry.name !== "node_modules" && !taken) move(from, to)
        else rmSync(join(root, from), { recursive: true, force: true })
      } else if (entry.isDirectory()) visit(from)
      else if (!taken) {
        move(from, to)
        carried.push({ from, to })
      } else if (same(join(root, from), join(root, to))) rmSync(join(root, from))
      else clashes.push(`${from} (${to} holds another)`)
    }
  }
  const empty = (path: string): boolean => {
    const full = join(root, path)
    if (!lstatSync(full).isDirectory()) return false
    const all = readdirSync(full).map((name) => empty(`${path}/${name}`))
    if (all.every(Boolean)) rmSync(full, { recursive: true, force: true })
    return all.every(Boolean)
  }
  for (const folder of folders) {
    if (!exists(join(root, folder)) || git("ls-files", folder).trim() !== "") continue
    visit(folder)
    empty(folder)
  }
  return { carried, clashes }
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
