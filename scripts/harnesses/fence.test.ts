import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

// The lint fence around the harness packages (`.oxlintrc.json`) names each package's
// neighbours by hand, as oxlint can't say "every other adapter": this checks that a package
// added under harnesses/ is fenced in, and fenced off from the others, before it lands.

type Rule = {
  readonly paths?: readonly { readonly name: string }[]
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
const adapters = readdirSync(join(root, "harnesses")).filter(
  (name) => name !== "core" && existsSync(join(root, "harnesses", name, "package.json")),
)

/** Every import the fence of a package forbids, by name or pattern; none where it's off. */
const banned = (folder: string): readonly string[] => {
  const [severity, rule] = config.overrides.find((each) =>
    each.files.includes(`harnesses/${folder}/**`),
  )?.rules?.["no-restricted-imports"] ?? ["off"]
  if (severity !== "error") return []
  return [
    ...(rule?.paths ?? []).map(({ name }) => name),
    ...(rule?.patterns ?? []).flatMap(({ group }) => group),
  ]
}

const runner = ["@novadeck/runner", "@novadeck/runner/**"]
const adapter = (id: string) => [`@novadeck/harness-${id}`, `@novadeck/harness-${id}/**`]

describe("the harness packages' lint fence", () => {
  it("finds the adapters", () => {
    expect(adapters).toEqual(expect.arrayContaining(["agy", "claude", "codex"]))
  })

  it.each(adapters)("keeps %s off the runner, the other adapters and what lies above it", (id) => {
    const others = adapters.filter((other) => other !== id).flatMap(adapter)
    expect(banned(id)).toEqual(expect.arrayContaining([...runner, ...others, "../**", "./../**"]))
  })

  it("keeps harness-core off the runner and every adapter", () => {
    expect(banned("core")).toEqual(
      expect.arrayContaining([...runner, ...adapters.flatMap(adapter)]),
    )
  })
})
