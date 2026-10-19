import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { mergeHead, resolveMerge } from "./merge-frontend.ts"

// Each test builds throwaway git repositories, and git is slow to start on Windows: these
// files' tests may take a minute, beside the default 5 s every other test keeps.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

// The merge step over throwaway repositories: a base, then the move on main and on a branch,
// each writing the generated files, and what each side did after.

const made: string[] = []
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true })
})

const manifest = (extra: Record<string, string> = {}) =>
  `${JSON.stringify({ name: "@novadeck/ui", scripts: { test: "vitest", ...extra } }, null, 2)}\n`
// The package the move writes, unlike the old one, as the real move's is: git sees no rename.
const written = (extra: Record<string, string> = {}) =>
  `${JSON.stringify(
    {
      name: "@novadeck/ui",
      type: "module",
      exports: Object.fromEntries(
        ["app", "entries/start", "styles.css", "theme/source", "theme/apply"].map((path) => [
          `./${path}`,
          `./src/${path}.ts`,
        ]),
      ),
      scripts: { test: "vitest run", typecheck: "tsc --noEmit", ...extra },
      dependencies: { "@novadeck/core": "workspace:*", react: "^19.3.0" },
    },
    null,
    2,
  )}\n`

const scene = () => {
  const root = mkdtempSync(join(tmpdir(), "merge-frontend-test-"))
  made.push(root)
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  const tryGit = (...args: string[]) => {
    try {
      return git(...args)
    } catch {
      return undefined
    }
  }
  const write = (file: string, text: string | Buffer) => {
    mkdirSync(join(root, dirname(file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const read = (file: string) => readFileSync(join(root, file), "utf8")
  // The move, as each side's run of the script writes it.
  // Each side's its own commit, as main's and a branch's runs are.
  const move = (generated: string, side: string) => {
    git("rm", "-q", "application/ui/package.json")
    git("mv", "application/ui/src/a.ts", "frontend/ui/src/a.ts")
    write("frontend/ui/package.json", written())
    write("frontend/core/gen.ts", generated)
    git("add", "-A")
    git("commit", "-qm", `the move, on ${side}`)
  }
  git("init", "-q", "-b", "main")
  write("application/ui/package.json", manifest())
  write("application/ui/src/a.ts", "a\n")
  git("add", "-A")
  git("commit", "-qm", "base")
  git("checkout", "-qb", "branch")
  mkdirSync(join(root, "frontend/ui/src"), { recursive: true })
  move("one\ntwo\nthree\n", "the branch")
  git("checkout", "-q", "main")
  mkdirSync(join(root, "frontend/ui/src"), { recursive: true })
  move("one\ntwo\nthree\n", "main")
  return { root, git, tryGit, write, read }
}
const merge = ({ git, tryGit }: ReturnType<typeof scene>) => {
  git("checkout", "-q", "branch")
  tryGit("merge", "--no-edit", "main")
}

describe("the merge step", () => {
  it("merges a generated file main changed since it wrote it, and is off once the merge is committed", () => {
    const s = scene()
    s.write("frontend/core/gen.ts", "one\ntwo\nthree\nfour\n")
    s.git("commit", "-qam", "main changes a generated file")
    s.git("checkout", "-q", "branch")
    s.write("frontend/core/gen.ts", "zero\none\ntwo\nthree\n")
    s.git("commit", "-qam", "the branch changes it too")
    merge(s)
    const head = mergeHead(s.root)!
    const { done, left } = resolveMerge(s.root, head)
    expect(left).toEqual([])
    expect(done).toContain("frontend/core/gen.ts")
    expect(s.read("frontend/core/gen.ts")).toBe("zero\none\ntwo\nthree\nfour\n")
    s.git("commit", "-qam", "merge")
    expect(mergeHead(s.root)).toBeUndefined()
    // A MERGE_HEAD left behind once the merge was committed, as an interrupted tool leaves it.
    writeFileSync(join(s.root, ".git/MERGE_HEAD"), head)
    expect(mergeHead(s.root)).toBeUndefined()
  })

  it("names the branch's edit to a manifest after its move, rather than take main's", () => {
    const s = scene()
    s.write("frontend/ui/package.json", written({ main: "1" }))
    s.git("commit", "-qam", "main's script")
    s.git("checkout", "-q", "branch")
    s.write("frontend/ui/package.json", written({ postmove: "1" }))
    s.git("commit", "-qam", "the branch's script after its move")
    merge(s)
    const { done, left } = resolveMerge(s.root, mergeHead(s.root)!)
    expect(done).not.toContain("frontend/ui/package.json")
    expect(left.join("\n")).toMatch(
      /frontend\/ui\/package\.json: the branch changed it after its move/,
    )
  })

  it("names a generated file one side deleted after its move", () => {
    const s = scene()
    s.git("rm", "-q", "frontend/core/gen.ts")
    s.git("commit", "-qm", "main drops a generated file")
    merge(s)
    const { left } = resolveMerge(s.root, mergeHead(s.root) ?? s.git("rev-parse", "main").trim())
    expect(left.join("\n")).toMatch(/frontend\/core\/gen\.ts: main deleted it after its move/)
  })

  it("leaves an add/add the move doesn't write, and one that isn't text, to a person", () => {
    const s = scene()
    s.write("docs-new.md", "main's\n")
    s.write("frontend/core/img.png", Buffer.from([0, 1, 2, 255]))
    s.git("add", "-A")
    s.git("commit", "-qm", "main adds files")
    s.git("checkout", "-q", "branch")
    s.write("docs-new.md", "the branch's\n")
    s.write("frontend/core/img.png", Buffer.from([0, 9, 9, 255]))
    s.git("add", "-A")
    s.git("commit", "-qm", "the branch adds the same files")
    merge(s)
    const { done, left } = resolveMerge(s.root, mergeHead(s.root)!)
    expect(done).toEqual([])
    expect(left.join("\n")).toMatch(/docs-new\.md: .* the move doesn't write/)
    expect(left.join("\n")).toMatch(/frontend\/core\/img\.png: .* the move doesn't write/)
  })

  it("leaves a file the person resolved by hand, on a second run", () => {
    const s = scene()
    s.write("frontend/core/gen.ts", "one\nTWO\nthree\n")
    s.git("commit", "-qam", "main")
    s.git("checkout", "-q", "branch")
    s.write("frontend/core/gen.ts", "one\n2\nthree\n")
    s.git("commit", "-qam", "branch")
    merge(s)
    const first = resolveMerge(s.root, mergeHead(s.root)!)
    expect(first.left.join("\n")).toMatch(/gen\.ts: both sides changed the same lines/)
    s.write("frontend/core/gen.ts", "one\ntwo, by hand\nthree\n")
    const second = resolveMerge(s.root, mergeHead(s.root)!)
    expect(second.left.join("\n")).toMatch(/gen\.ts: resolved by hand/)
    expect(s.read("frontend/core/gen.ts")).toBe("one\ntwo, by hand\nthree\n")
  })
})
