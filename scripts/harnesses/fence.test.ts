import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// The lint fence around the harness packages (`.oxlintrc.json`) holds the paths only: the
// package graph keeps an adapter off the runner and the other adapters, as their package.json
// names neither, but a relative path bypasses package.json. This checks that a package added
// under harnesses/ is fenced off from what lies above its sources before it lands.

type Rule = {
  readonly patterns?: readonly { readonly group: readonly string[] }[]
}
type Override = {
  readonly files: readonly string[]
  readonly rules?: { readonly "no-restricted-imports"?: readonly [string, Rule?] }
}

const root = join(import.meta.dirname, "..", "..")
const config = JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8")) as {
  readonly overrides: readonly Override[]
}
const packages = readdirSync(join(root, "harnesses")).filter((name) =>
  existsSync(join(root, "harnesses", name, "package.json")),
)

/** Every import the fence of a package forbids by pattern; none where it's off. */
const banned = (folder: string): readonly string[] => {
  const [severity, rule] = config.overrides.find((each) =>
    each.files.includes(`harnesses/${folder}/**`),
  )?.rules?.["no-restricted-imports"] ?? ["off"]
  if (severity !== "error") return []
  return (rule?.patterns ?? []).flatMap(({ group }) => group)
}

describe("the harness packages' lint fence", () => {
  it("finds the adapters", () => {
    expect(packages).toEqual(expect.arrayContaining(["agy", "claude", "codex", "core"]))
  })

  it.each(packages.filter((name) => name !== "core"))(
    "keeps %s off what lies above its sources",
    (id) => {
      expect(banned(id)).toEqual(expect.arrayContaining(["../**", "./../**"]))
    },
  )
})
