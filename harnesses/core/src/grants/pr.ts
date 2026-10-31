// The `pr` preset (Appendix A2): gh pr create --head <b> | edit | ready | comment <n>, with -R.
import type { GrantRepo } from "../grants.js"
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
] as const)
  for (const alias of names) options.set(alias, { name: names[0], value, many })

/** Whether `argv` is a pull request command the preset allows in the granted `repos`. */
export const matchesPr = (argv: readonly string[], repos: readonly GrantRepo[]): boolean => {
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

  const repo = given.get("--repo")
  const key = repo === undefined ? undefined : ghRepoKey(repo)
  if (key === undefined || !repos.some((granted) => repoKey(granted.url) === key)) return false
  if (sub === "create") {
    const head = given.get("--head")
    return positional.length === 0 && head !== undefined && isBranchName(head)
  }
  return positional.length === 1 && /^[0-9]+$/.test(positional[0] as string)
}
