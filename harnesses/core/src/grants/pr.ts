import type { GrantRepo } from "../grants.js"
// The `pr` preset (Appendix A2): gh pr create --head <b> | edit | ready | comment <n>, with -R.
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

/**
 * Whether `path`, a `--body-file` value, names a file inside the project: no `..` in it, and
 * resolved against the call's folder, else the project root, lexically inside the root. Never
 * `-`, which reads the agent's stdin.
 */
const bodyFileInside = (path: string, { cwd, root }: BodyFiles): boolean => {
  if (path === "" || path === "-" || path.split(/[\\/]+/).includes("..")) return false
  const rules = flavourOf(path, root, cwd ?? undefined)
  return inside(rules.resolve(cwd ?? root, path), root)
}

/**
 * Whether `argv` is a pull request command the preset allows in the granted `repos`.
 * `--body-file` takes a file inside the project (`files`), for create, edit and comment: a
 * `--body` already lets any text through, so a file the agent could read adds no way out.
 */
export const matchesPr = (
  argv: readonly string[],
  repos: readonly GrantRepo[],
  files: BodyFiles,
): boolean => {
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
  if (bodyFile !== undefined && (sub === "ready" || !bodyFileInside(bodyFile, files))) return false
  const repo = given.get("--repo")
  const key = repo === undefined ? undefined : ghRepoKey(repo)
  if (key === undefined || !repos.some((granted) => repoKey(granted.url) === key)) return false
  if (sub === "create") {
    const head = given.get("--head")
    return positional.length === 0 && head !== undefined && isBranchName(head)
  }
  return positional.length === 1 && /^[0-9]+$/.test(positional[0] as string)
}
