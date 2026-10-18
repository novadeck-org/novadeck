import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  budgetsPath,
  countManager,
  managerPath,
  ratchetNotes,
  ratchetProblems,
  type Budgets,
  type Counts,
} from "./manager"

// backend/runner/src/terminals/manager.ts holds a budget of lines and of methods in
// its Terminals class that only goes down: new behaviour goes in a sibling module under
// terminals/, and the class calls it.

const root = join(import.meta.dirname, "..", "..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })

// Where this change left its base. In a pull request's CI, the merge commit's first parent
// (the Quality workflow checks out two commits deep); anywhere else, where the branch left
// main, as a local merge of main into a branch has the branch's own tip first.
const baseCommit = (): string | undefined => {
  if (process.env.GITHUB_BASE_REF)
    try {
      git("rev-parse", "--verify", "HEAD^2")
      return git("rev-parse", "HEAD^1").trim()
    } catch {
      // Not a merge commit: where the branch left main, if git can see it.
    }
  for (const branch of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", branch).trim()
    } catch {
      // Not this branch: try the next.
    }
  }
  return undefined
}

// What the change starts from: the base branch's budgets (none where the base has no file
// yet), and whether the change touches manager.ts or its budgets at all. A pull request's
// CI must find its base, or a raise there would go unchecked.
const base = (): { readonly budgets?: Budgets; readonly touched: boolean } => {
  const commit = baseCommit()
  if (!commit) {
    if (process.env.GITHUB_BASE_REF)
      throw new Error(
        `The ratchet reads the base branch's ${budgetsPath} from the pull request's merge commit, which this checkout can't see: check out two commits deep (fetch-depth: 2).`,
      )
    return { touched: true }
  }
  let touched = false
  try {
    git("diff", "--quiet", commit, "--", managerPath, budgetsPath)
  } catch {
    touched = true
  }
  try {
    return { budgets: JSON.parse(git("show", `${commit}:${budgetsPath}`)) as Budgets, touched }
  } catch {
    return { touched }
  }
}

describe("manager.ts", () => {
  it("stays within its budgets, and no further under them than their slack", () => {
    const budgets = JSON.parse(read(budgetsPath)) as Budgets
    const counts = countManager(read(managerPath))
    const from = base()
    const problems = ratchetProblems(counts, budgets, from.budgets)
    // Straight to stderr: Vitest keeps a passing test's console output to itself.
    const say = (text: string): boolean => process.stderr.write(`${text}\n`)
    ratchetNotes(counts, budgets).forEach(say)
    // A change that leaves manager.ts and its budgets alone isn't held to what others left,
    // as two changes merged one after the other can: the next change to them is.
    if (!from.touched) {
      problems.forEach((problem) => say(`Left for the next change to manager.ts: ${problem}`))
      return
    }
    expect(problems).toEqual([])
  })
})

describe("counting the Terminals class", () => {
  const terminals = `
    import type { Thing } from "./thing"
    const helper = (): void => {}
    export class Terminals {
      private readonly items = new Map<string, Thing>()
      private count = 0
      private readonly onExit = (code: number): void => {}
      private readonly onData = function (data: string): void {}
      constructor(name: string = "x") {}
      get size(): number { return this.items.size }
      set size(value: number) {}
      open(id: string): void { helper() }
      async close(id: string): Promise<void> {}
      static create(): Terminals { return new Terminals() }
    }
    class Other { method(): void {} }
  `

  it("counts every function its body defines, and nothing outside it", () => {
    expect(countManager(terminals).methods).toBe(8)
  })

  it("counts the same however the code is laid out", () => {
    const spread = terminals.replaceAll("(", "(\n\n").replaceAll("{", "{ // note\n")
    expect(countManager(spread).methods).toBe(countManager(terminals).methods)
  })

  it("counts the file's lines, a last newline or none", () => {
    expect(countManager("export class Terminals {}\n").lines).toBe(1)
    expect(countManager("// a\nexport class Terminals {}").lines).toBe(2)
  })

  it("refuses a file without one Terminals class", () => {
    expect(() => countManager("export class Other {}")).toThrow(/one Terminals class/)
  })

  it("refuses a file with more than one, saying how many", () => {
    const two = "export class Terminals { a() { class Terminals {} } }"
    expect(() => countManager(two)).toThrow(/it defines 2/)
  })

  it("refuses code its parser can't read, naming the file", () => {
    expect(() => countManager("export class Terminals { accessor x = 1 }")).toThrow(
      /manager.ts has syntax the ratchet's parser can't read/,
    )
  })

  it("refuses syntax it can't read, saying what to write instead", () => {
    const enumerated = "enum Kind { A }\nexport class Terminals {}"
    expect(() => countManager(enumerated)).toThrow(/without enums, namespaces or parameter/)
  })
})

describe("the ratchet", () => {
  const counts: Counts = { lines: 100, methods: 10 }
  const budgets: Budgets = { lines: 100, methods: 10, slack: { lines: 5, methods: 1 } }

  it("holds while the counts meet their budgets", () => {
    expect(ratchetProblems(counts, budgets)).toEqual([])
  })

  it("sends new code past a budget to a sibling module under terminals/", () => {
    const [problem] = ratchetProblems({ ...counts, methods: 11 }, budgets)
    expect(problem).toMatch(/11 methods in the Terminals class, past its budget of 10/)
    expect(problem).toMatch(/sibling module under backend\/runner\/src\/terminals\//)
  })

  it("lets the file sit a little under a budget, saying it could come down", () => {
    const shrunk = { ...counts, lines: 95 }
    expect(ratchetProblems(shrunk, budgets)).toEqual([])
    expect(ratchetNotes(shrunk, budgets)).toEqual([
      expect.stringMatching(/95 lines, under its budget of 100: it could be lowered to 95/),
    ])
  })

  it("asks for a budget to come down once the file sits further under it than its slack", () => {
    expect(ratchetProblems({ ...counts, lines: 94, methods: 8 }, budgets)).toEqual([
      expect.stringMatching(
        /94 lines, 6 under its budget of 100, past the 5 .* lower the budget .* to 94/,
      ),
      expect.stringMatching(
        /8 methods in the Terminals class, 2 under its budget of 10, past the 1/,
      ),
    ])
  })

  it("refuses a budget file without slack", () => {
    const { slack: _none, ...without } = budgets
    expect(ratchetProblems(counts, without as Budgets)).toEqual([
      expect.stringMatching(/sets no slack for lines/),
      expect.stringMatching(/sets no slack for methods/),
    ])
  })

  it("lets a raise stand with why and where it came from", () => {
    const raised: Budgets = {
      ...budgets,
      methods: { budget: 11, reason: "A new protocol call", from: "#240" },
    }
    expect(ratchetProblems({ ...counts, methods: 11 }, raised, budgets)).toEqual([])
  })

  it("refuses a raise that doesn't say why or where it came from", () => {
    expect(
      ratchetProblems({ ...counts, methods: 11 }, { ...budgets, methods: 11 }, budgets),
    ).toEqual([expect.stringMatching(/raises methods from 10 to 11 without saying why/)])
    const unsaid: Budgets = { ...budgets, methods: { budget: 11, reason: " ", from: "#240" } }
    expect(ratchetProblems({ ...counts, methods: 11 }, unsaid, budgets)).toEqual([
      expect.stringMatching(
        /is written \{ "budget": n, "reason": "why", "from": "#PR or commit" \}/,
      ),
    ])
  })

  it("refuses a raise that names the earlier raise's source", () => {
    const earlier: Budgets = {
      ...budgets,
      methods: { budget: 11, reason: "A protocol call", from: "#240" },
    }
    const again: Budgets = {
      ...budgets,
      methods: { budget: 15, reason: "A protocol call", from: "#240" },
    }
    expect(ratchetProblems({ ...counts, methods: 15 }, again, earlier)).toEqual([
      expect.stringMatching(/under the earlier raise's source, #240/),
    ])
  })

  it("refuses a raise past what the file needs, which would bank headroom", () => {
    const padded: Budgets = {
      ...budgets,
      lines: { budget: 103, reason: "Headroom", from: "#240" },
    }
    expect(ratchetProblems({ ...counts, lines: 101 }, padded, budgets)).toEqual([
      expect.stringMatching(/raises lines to 103, past the 101 the file has: raise it only to 101/),
    ])
  })

  it("refuses a raise the file doesn't need, keeping the budget it had", () => {
    const needless: Budgets = { ...budgets, lines: { budget: 102, reason: "Room", from: "#240" } }
    expect(ratchetProblems({ ...counts, lines: 98 }, needless, budgets)).toEqual([
      expect.stringMatching(
        /raises lines to 102, though the file's 98 needs no raise: keep it at 100 at most/,
      ),
    ])
  })

  it("reads a hand-written null as no budget or slack, not a crash", () => {
    const blank = { ...budgets, slack: { lines: null, methods: 1 } } as unknown as Budgets
    expect(ratchetProblems(counts, blank)).toEqual([
      expect.stringMatching(/sets no slack for lines/),
    ])
  })

  it("keeps an earlier raise standing as the file shrinks within its slack", () => {
    const raised: Budgets = { ...budgets, lines: { budget: 103, reason: "A call", from: "#240" } }
    expect(ratchetProblems({ ...counts, lines: 101 }, raised, raised)).toEqual([])
    expect(ratchetProblems({ ...counts, lines: 101 }, raised)).toEqual([])
  })

  it("guards a slack's raise as a budget's, and lets it come down freely", () => {
    const wider: Budgets = { ...budgets, slack: { lines: 50, methods: 1 } }
    expect(ratchetProblems(counts, wider, budgets)).toEqual([
      expect.stringMatching(/raises lines slack from 5 to 50 without saying why/),
    ])
    const said: Budgets = {
      ...budgets,
      slack: { lines: { budget: 50, reason: "Big extractions", from: "#250" }, methods: 1 },
    }
    expect(ratchetProblems(counts, said, budgets)).toEqual([])
    const narrower: Budgets = { ...budgets, slack: { lines: 2, methods: 0 } }
    expect(ratchetProblems(counts, narrower, budgets)).toEqual([])
  })

  it("lets a budget come down with no reason", () => {
    const lowered: Budgets = { ...budgets, lines: 90 }
    expect(ratchetProblems({ ...counts, lines: 90 }, lowered, budgets)).toEqual([])
  })
})
