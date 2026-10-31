// The `pr` preset (Appendix A2): gh pr create --head <b> | edit | ready | comment <n>, with -R.
import { posix } from "node:path"

import type { FsLookups, GrantRepo } from "../grants.js"
import { flavourOf } from "../paths.js"
import { inside } from "./inside.js"
import { isBranchName } from "./refname.js"
import { ghRepoKey, repoKey } from "./repo.js"

type Option = { readonly name: string; readonly value: boolean; readonly many: boolean }

const options = new Map<string, Option>()
for (const [names, value, many] of [
  [["--title", "-t"], true, false],
  [["--body", "-b"], true, false],
  [["--base", "-B"], true, false],
  [["--head", "-H"], true, false],
  [["--repo", "-R"], true, false],
  [["--reviewer", "-r"], true, true],
  [["--add-reviewer"], true, true],
  [["--assignee", "-a"], true, true],
  [["--draft", "-d"], false, false],
  [["--fill"], false, false],
  [["--body-file"], true, false],
] as const)
  for (const alias of names) options.set(alias, { name: names[0], value, many })

/** Where a call runs and the project it must stay in, for a body file's path. */
export type BodyFiles = { readonly cwd: string | null; readonly root: string }

// Windows' reserved device names: `CON`, `NUL.txt` and `com1.x.y` open a device, not a file.
const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Whether `path`, a `--body-file` value, names a file inside the project: no `..` in it, and
 * resolved against the call's folder, lexically inside the root. Never `-`, which reads the
 * agent's stdin. Where the folder is unknown (`cwd` null: Codex, Antigravity) only a fully
 * qualified path counts: `X:\…` or `X:/…` on Windows, never a rooted `\x`, a drive-relative
 * `C:x`, a UNC path or `\\?\`, and `/…` elsewhere. On Windows no segment may name a device or
 * hold a `:` after the drive (a stream).
 */
const bodyFilePath = (path: string, { cwd, root }: BodyFiles): string | undefined => {
  if (path === "" || path === "-" || path.split(/[\\/]+/).includes("..")) return undefined
  const rules = flavourOf(path, root, cwd ?? undefined)
  const windows = flavourOf(root) !== posix
  if (windows) {
    const rest = /^[A-Za-z]:[\\/]/.test(path) ? path.slice(2) : path
    if (rest.includes(":")) return undefined
    if (rest.split(/[\\/]+/).some((segment) => device.test(segment.split(".")[0] as string)))
      return undefined
  } else if (path.includes("\\")) return undefined
  if (cwd === null && !(windows ? /^[A-Za-z]:[\\/]/ : /^\//).test(path)) return undefined
  const resolved = rules.resolve(cwd ?? root, path)
  return inside(resolved, root) ? resolved : undefined
}

/** Whether `path` is a regular file whose real path, and the root's, still puts it inside. */
const realFileInside = async (path: string, root: string, fs: FsLookups): Promise<boolean> => {
  const [file, base] = await Promise.all([fs.real(path), fs.real(root)])
  return file?.file === true && base !== undefined && inside(file.path, base.path)
}

/**
 * Whether `argv` is a pull request command the preset allows in the granted `repos`.
 * `--body-file` takes a regular file inside the project (`files`, by real path too, read
 * through `fs`), for create, edit and comment: a `--body` already lets any text through, so a
 * file the agent could read adds no way out.
 */
export const matchesPr = async (
  argv: readonly string[],
  repos: readonly GrantRepo[],
  files: BodyFiles,
  fs: FsLookups,
): Promise<boolean> => {
  const sub = argv[2]
  if (argv[0] !== "gh" || argv[1] !== "pr") return false
  if (sub !== "create" && sub !== "edit" && sub !== "ready" && sub !== "comment") return false

  const given = new Map<string, string>()
  const positional: string[] = []
  for (let i = 3; i < argv.length; i += 1) {
    const word = argv[i] as string
    if (!word.startsWith("-")) {
      positional.push(word)
      continue
    }
    const eq = word.startsWith("--") ? word.indexOf("=") : -1
    const option = options.get(eq < 0 ? word : word.slice(0, eq))
    if (option === undefined) return false
    let value = ""
    if (option.value) {
      const next = eq < 0 ? argv[(i += 1)] : word.slice(eq + 1)
      if (next === undefined) return false
      value = next
    } else if (eq >= 0) return false
    if (given.has(option.name) && !option.many) return false
    given.set(option.name, option.many ? `${given.get(option.name) ?? ""}${value}\n` : value)
  }

  const bodyFile = given.get("--body-file")
  const bodyPath = bodyFile === undefined ? undefined : bodyFilePath(bodyFile, files)
  if (bodyFile !== undefined && (sub === "ready" || bodyPath === undefined)) return false
  const repo = given.get("--repo")
  const key = repo === undefined ? undefined : ghRepoKey(repo)
  if (key === undefined || !repos.some((granted) => repoKey(granted.url) === key)) return false
  if (sub === "create") {
    const head = given.get("--head")
    if (positional.length !== 0 || head === undefined || !isBranchName(head)) return false
  } else if (positional.length !== 1 || !/^[0-9]+$/.test(positional[0] as string)) return false
  // Last, as it reads the disk: a symlink inside the project can point out of it.
  return bodyPath === undefined || realFileInside(bodyPath, files.root, fs)
}
