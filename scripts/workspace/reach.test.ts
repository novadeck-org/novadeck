import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { lint, probeConfig } from "./oxlint.ts"
import { declaredReads, workspacePackages } from "./platform.ts"

const root = join(import.meta.dirname, "..", "..")

// The reach fence (reach.ts), proven as the platform fence is: a probe workspace of its own,
// linted with the real config, and the lines it refuses read back. The reading package,
// frontend/reader, depends on libraries/dependency and not on backend/other, and declares it
// reads docs/read.md and elsewhere/declared; scripts/narrowed has a scope.

const header = [
  `import { execFileSync } from "node:child_process"`,
  `import { readdirSync, readFileSync } from "node:fs"`,
  `import { dirname, join, resolve } from "node:path"`,
  `import { fileURLToPath } from "node:url"`,
  `const root = join(import.meta.dirname, "..", "..", "..")`,
  `const here = dirname(fileURLToPath(import.meta.url))`,
  `const sheet = "backend/other/src/styles.css"`,
  `export const named = (name: string) => readFileSync(join(root, "elsewhere/declared", name))`,
]
const refused = [
  `readFileSync(join(import.meta.dirname, "../../../backend/other/src/a.ts"))`,
  `readFileSync(new URL("../../../backend/other/a.json", import.meta.url))`,
  `readFileSync(new URL("../../../backend/other/b.json", import.meta.url).pathname)`,
  "readFileSync(`${import.meta.dirname}/../../../backend/other/b.ts`)",
  `readFileSync(join(root, "backend/other/x.ts"))`,
  `readFileSync(join(root, "backend", "other", "y.ts"))`,
  `readFileSync(join(here, "../../../backend/other/z.ts"))`,
  `readFileSync(resolve(__dirname, "../../../backend/other/c.ts"))`,
  `readFileSync(join(root, sheet))`,
  `readdirSync(root)`,
  `readdirSync(join(root, "frontend"))`,
  `export const any = (name: string) => readFileSync(join(root, name))`,
  `execFileSync("git", ["ls-files"], { cwd: root })`,
  `readFileSync(join(root, "docs/other.md"))`,
  `readFileSync(join(root, "README.md"))`,
  `readFileSync(join(process.cwd(), "..", "..", "docs", "theming.md"))`,
  `readFileSync(join(root, "scripts/narrowed/budget.json"))`,
  `readFileSync(join(import.meta.dirname, "../../../..", "outside"))`,
  `import "../../../backend/other/src/index.ts"`,
  `export * from "../../../backend/other/src/index.ts"`,
  `import "@probe/other"`,
  `export { thing } from "@probe/other/sub"`,
  `await import("@probe/other")`,
]
const allowed = [
  `readFileSync(join(import.meta.dirname, "fixture.json"))`,
  `readdirSync(join(import.meta.dirname, ".."))`,
  `readFileSync(join(import.meta.dirname, "../../../libraries/dependency/src/a.ts"))`,
  `readFileSync(join(root, "libraries/dependency", "b.ts"))`,
  `readFileSync(join(root, "node_modules/zod/package.json"))`,
  `readFileSync(join(root, "docs/read.md"))`,
  `readFileSync(join(root, "elsewhere/declared/deep/file.txt"))`,
  `readFileSync(join(root, "scripts/install/install.sh"))`,
  `readFileSync(join(root, "LICENSE"))`,
  `readFileSync(new URL("./sibling.json", import.meta.url))`,
  `readFileSync(join(root, "frontend/reader/src/a.ts"))`,
  `readFileSync(join(process.cwd(), "src", "fixture.json"))`,
  `import "./sibling.ts"`,
  `import "@probe/dependency/sub"`,
  `import "@probe/reader"`,
  `import "zod"`,
  `export const relative = join("..", "..", "anything")`,
]
const probe = [...header, ...refused, ...allowed].join("\n")

let refusals: readonly string[] = []
let elsewhere: readonly string[] = []
let workspace = ""

const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true })
  writeFileSync(join(workspace, path), text)
}
const manifest = (name: string, rest: object = {}) =>
  JSON.stringify({ name, novadeck: { platform: "system" }, ...rest })

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "novadeck-reach-fence-"))
  writeFileSync(join(workspace, ".oxlintrc.json"), probeConfig())
  copyFileSync(join(root, "pnpm-workspace.yaml"), join(workspace, "pnpm-workspace.yaml"))
  write("package.json", JSON.stringify({ name: "root", private: true }))
  write(
    "frontend/reader/package.json",
    manifest("@probe/reader", {
      novadeck: { platform: "system", reads: ["docs/read.md", "elsewhere/declared"] },
      devDependencies: { "@probe/dependency": "workspace:*" },
    }),
  )
  write("libraries/dependency/package.json", manifest("@probe/dependency"))
  write("backend/other/package.json", manifest("@probe/other"))
  write("frontend/plain/package.json", manifest("@probe/plain"))
  write(
    "scripts/narrowed/ci-scope.json",
    JSON.stringify({ reaches: "repository", why: "A probe." }),
  )
  write("frontend/reader/src/probe.test.ts", `${probe}\n`)
  // The same reads from a package that declares none, and from outside every package.
  write("frontend/plain/src/probe.test.ts", `${probe}\n`)
  write("scripts/tool/probe.ts", `${probe}\n`)
  const diagnostics = lint(workspace).filter(({ code }) => code === "novadeck(reach)")
  const lineOf = (line: number) => probe.split("\n")[line - 1] ?? `${line}`
  refusals = [
    ...new Set(
      diagnostics
        .filter(({ filename }) => filename === "frontend/reader/src/probe.test.ts")
        .map(({ labels }) => lineOf(labels?.[0]?.span.line ?? 0)),
    ),
  ]
  elsewhere = diagnostics
    .filter(({ filename }) => filename !== "frontend/reader/src/probe.test.ts")
    .map(({ filename, labels }) => `${filename}: ${lineOf(labels?.[0]?.span.line ?? 0)}`)
})

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe("the reach fence", () => {
  it.each(refused.map((line) => ({ line })))("refuses $line", ({ line }) => {
    expect(refusals).toContain(line)
  })

  it.each(allowed.map((line) => ({ line })))("allows $line", ({ line }) => {
    expect(refusals).not.toContain(line)
  })

  it("refuses nothing in the lines that only build a path", () => {
    expect(refusals.filter((line) => header.includes(line) && line !== header.at(-1))).toEqual([])
  })

  it("allows a name it can't follow under a folder declared whole", () => {
    expect(refusals).not.toContain(header.at(-1))
  })

  it("refuses what isn't declared in a package that declares nothing, and nothing outside one", () => {
    expect(elsewhere.filter((each) => each.startsWith("scripts/"))).toEqual([])
    expect(elsewhere).toEqual(
      expect.arrayContaining([
        'frontend/plain/src/probe.test.ts: readFileSync(join(root, "docs/read.md"))',
      ]),
    )
  })
})

describe("the reach fence's escapes", () => {
  // A file that turns the fence off must belong to a package that declares what it reads.
  it("sit only in packages that declare what they read", () => {
    const escapes = execFileSync(
      "git",
      ["grep", "-l", "-E", "oxlint-disable(-next-line)? .*novadeck/reach", "--", "*.ts", "*.tsx"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter((file) => file && !file.startsWith("scripts/"))
    const packages = workspacePackages(root)
    expect(escapes.length).toBeGreaterThan(0)
    expect(
      escapes.filter((file) => {
        const owner = packages.find(({ folder }) => file.startsWith(`${folder}/`))
        return !owner || (declaredReads(owner.manifest) ?? []).length === 0
      }),
    ).toEqual([])
  })

  it("is never the whole-file form without a reason beside it", () => {
    const files = execFileSync(
      "git",
      ["grep", "-l", "oxlint-disable novadeck/reach", "--", "*.ts"],
      {
        cwd: root,
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter((file) => file && !file.startsWith("scripts/"))
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8")
      expect(text, file).toMatch(
        /novadeck\.reads[^\n]*\n(?:\/\/[^\n]*\n)*\/\/ oxlint-disable novadeck\/reach/,
      )
    }
  })
})
