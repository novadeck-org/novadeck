import { describe, expect, it } from "vitest"

import {
  applyEdit,
  cleanPaths,
  conflictMarkers,
  mergeManifests,
  crossPathProblems,
  packageName,
  withBranchAdditions,
  cycleProblem,
  dependenciesOf,
  destinationOf,
  edgesOf,
  edits,
  leftovers,
  packageOf,
  packages,
  pathBelowUi,
  plan,
  policy,
  rewriteImports,
  rewritePaths,
  type Planned,
  type Policy,
} from "./frontend.ts"

const ui = "application/ui"

// What the tooling of every package needs a version for.
const tooling = {
  typescript: "^7.0.2",
  vitest: "^5.0.3",
  vite: "^7.3.6",
  jsdom: "^30.1.2",
  "@types/node": "^26.6.5",
  "@types/react": "^19.3.0",
  "@types/react-dom": "^19.3.0",
  "@vitest/browser-playwright": "5.0.3",
  playwright: "^1.64.0",
  tailwindcss: "^4.3.3",
  "@ark-ui/react": "^5.39.3",
  "@xyflow/react": "^12.12.0",
  "react-dom": "^19.3.0",
  "react-grid-layout": "^2.3.0",
}

// A small old UI: just enough files for every kind of import.
const old = new Map<string, string>([
  [
    `${ui}/package.json`,
    JSON.stringify({
      name: "@novadeck/ui",
      dependencies: { react: "^19.3.0", clsx: "^2.1.1" },
      devDependencies: tooling,
    }),
  ],
  ["tools/build-kit/package.json", JSON.stringify({ name: "@novadeck/build-kit" })],
  ...["protocol", "emulator", "wire"].map((name): [string, string] => [
    `libraries/${name}/package.json`,
    JSON.stringify({ name: `@novadeck/${name}` }),
  ]),
  [`${ui}/src/test.ts`, 'export { describe as context, describe, expect, it } from "vitest"\n'],
  [`${ui}/src/core/types.ts`, "export type T = string\n"],
  [`${ui}/src/core/store.ts`, 'import type { T } from "./types"\nexport const store: T = ""\n'],
  [
    `${ui}/src/core/store.test.ts`,
    'import { fixture } from "../test/fixtures"\nimport { expect, it } from "../test"\n',
  ],
  [
    `${ui}/src/test/fixtures.ts`,
    'import type { T } from "#core/types"\nexport const fixture: T = ""\n',
  ],
  [
    `${ui}/src/test/render.ts`,
    'import { store } from "#core/store"\nexport const render = store\n',
  ],
  [
    `${ui}/src/test/commands.ts`,
    'import { store } from "#core/store"\nexport const commands = store\n',
  ],
  [
    `${ui}/src/shell/Header.tsx`,
    'import { store } from "#core/store"\nimport { clsx } from "clsx"\nexport const Header = () => clsx(store)\n',
  ],
  [
    `${ui}/src/shell/Header.test.ts`,
    'import { render } from "../test/render"\nimport { commands } from "../test/commands"\nimport { it } from "../test"\nimport "./Header.css"\nvi.mock("#core/store")\n',
  ],
  [`${ui}/src/shell/Header.css`, '@import "tailwindcss";\n@import "../theme/base.css";\n'],
  [`${ui}/src/theme/base.css`, "body {}\n"],
  [
    `${ui}/src/entries/desktop.tsx`,
    'export const run = async () => (await import("../backend/runner")).connect\n',
  ],
  [
    `${ui}/src/backend/runner/index.ts`,
    'import { mount } from "../terminal-views/mount"\nexport const connect = mount\n',
  ],
  [
    `${ui}/src/backend/runner/index.test.ts`,
    'import { it } from "../../test"\nimport { fixture } from "../../test/fixtures"\nimport { connect } from "./index"\n',
  ],
  [
    `${ui}/src/backend/terminal-views/mount.ts`,
    'import type { T } from "#core/types"\nexport const mount = (t: T) => t\n',
  ],
  [`${ui}/src/backend/demo/index.ts`, 'import raw from "./plan.md?raw"\nexport default raw\n'],
  [`${ui}/src/backend/demo/plan.md`, "# plan\n"],
])

const placed = (file: string): string => destinationOf(file) ?? file
const tracked = new Set(old.keys())
const rewrite = (
  file: string,
  text = old.get(file) ?? "",
  use: ReadonlySet<string> = tracked,
  rule?: Policy,
) => rewriteImports(file, text, use, rule)

describe("where 5.3b moves a file", () => {
  it("takes each folder of the UI to its package, and what has no rule stays in the UI", () => {
    expect(destinationOf(`${ui}/src/core/store.ts`)).toBe("frontend/core/src/store.ts")
    expect(destinationOf(`${ui}/src/test/fixtures.ts`)).toBe("frontend/core/src/testing.ts")
    expect(destinationOf(`${ui}/src/test/render.ts`)).toBe("frontend/test-kit/src/render.ts")
    expect(destinationOf(`${ui}/src/test/commands.ts`)).toBe("frontend/ui/src/test/commands.ts")
    expect(destinationOf(`${ui}/src/test.ts`)).toBe("frontend/ui/src/test.ts")
    expect(destinationOf(`${ui}/src/backend/runner/index.ts`)).toBe(
      "frontend/runner-adapter/src/index.ts",
    )
    expect(destinationOf(`${ui}/src/backend/demo/debug/a.ts`)).toBe("frontend/demo-debug/src/a.ts")
    expect(destinationOf(`${ui}/src/backend/demo/b.ts`)).toBe("frontend/demo/src/b.ts")
    expect(destinationOf(`${ui}/src/specs/setup.ts`)).toBe("frontend/specs/src/setup.ts")
    expect(destinationOf(`${ui}/src/entries/try.tsx`)).toBe("apps/try/src/main.tsx")
    expect(destinationOf(`${ui}/entries/previews/main.tsx`)).toBeNull()
    expect(destinationOf(`${ui}/src/shell/Header.tsx`)).toBe("frontend/ui/src/shell/Header.tsx")
    expect(destinationOf(`${ui}/public/theme-boot.js`)).toBe("frontend/ui/public/theme-boot.js")
    expect(destinationOf("backend/runner/src/cli.ts")).toBeUndefined()
  })
})

describe("the import rewrite", () => {
  it("points #core/x at the core package, in every form an import takes", () => {
    const header = rewrite(`${ui}/src/shell/Header.tsx`)
    expect(header.problems).toEqual([])
    expect(header.text).toContain('from "@novadeck/core/store"')
    expect(header.text).toContain('from "clsx"')
    expect(rewrite(`${ui}/src/shell/Header.test.ts`).text).toContain(
      'vi.mock("@novadeck/core/store")',
    )
  })

  it("points an import across a new boundary at the package's subpath", () => {
    const adapter = rewrite(`${ui}/src/backend/runner/index.ts`)
    expect(adapter.problems).toEqual([])
    expect(adapter.text).toContain('from "@novadeck/terminal-views/mount"')
    const entry = rewrite(`${ui}/src/entries/desktop.tsx`)
    expect(entry.text).toContain('import("@novadeck/runner-adapter")')
  })

  it("sends the test helpers to their packages, and keeps the UI's own", () => {
    const test = rewrite(`${ui}/src/shell/Header.test.ts`).text
    expect(test).toContain('from "@novadeck/test-kit/render"')
    expect(test).toContain('from "../test/commands"')
    expect(test).toContain('import "./Header.css"')
    expect(rewrite(`${ui}/src/backend/runner/index.test.ts`).text).toContain(
      'from "@novadeck/core/testing"',
    )
  })

  it("gives each package its own copy of the Vitest re-export, relative to the file", () => {
    const adapter = rewrite(`${ui}/src/backend/runner/index.test.ts`)
    expect(adapter.text).toContain('from "./test"')
    expect([...adapter.copies]).toEqual(["frontend/runner-adapter"])
    const core = rewrite(`${ui}/src/core/store.test.ts`)
    expect(core.text).toContain('from "./test"')
    expect(core.text).toContain('from "./testing"')
    expect(rewrite(`${ui}/src/shell/Header.test.ts`).text).toContain('from "../test"')
  })

  it("rewrites what the fixtures and the terminal views import of the core", () => {
    expect(rewrite(`${ui}/src/test/fixtures.ts`).text).toContain('from "./types"')
    expect(rewrite(`${ui}/src/backend/terminal-views/mount.ts`).text).toContain(
      'from "@novadeck/core/types"',
    )
  })

  it("keeps a query on a file of the same package, and a stylesheet's @import", () => {
    expect(rewrite(`${ui}/src/backend/demo/index.ts`).text).toBe(
      old.get(`${ui}/src/backend/demo/index.ts`),
    )
    expect(rewrite(`${ui}/src/shell/Header.css`).text).toBe(old.get(`${ui}/src/shell/Header.css`))
  })

  it("rewrites a stylesheet's import of another package", () => {
    const files = new Set([...tracked, `${ui}/src/backend/terminal-views/terminal-xterm.css`])
    const css = rewrite(
      `${ui}/src/styles.css`,
      '@import "./backend/terminal-views/terminal-xterm.css";\n',
      files,
    )
    expect(css.text).toBe('@import "@novadeck/terminal-views/terminal-xterm.css";\n')
  })

  it("fails the plan on an import it can't place, rather than guess", () => {
    const missing = rewrite(
      `${ui}/src/shell/Header.tsx`,
      'import { x } from "./Missing"\nimport "#core/nothing"\n',
    )
    expect(missing.problems).toHaveLength(2)
    expect(missing.problems[0]).toContain('src/shell/Header.tsx:1: "./Missing"')
    const deleted = rewrite(
      `${ui}/src/shell/Header.tsx`,
      'import "../../entries/previews/main"\n',
      new Set([...tracked, `${ui}/entries/previews/main.tsx`]),
    )
    expect(deleted.problems.join()).toContain("which the move deletes")
  })

  it("ignores what only looks like an import: a sentence in a comment", () => {
    const text = '// the dialog comes from "this file | that one"\n'
    expect(rewrite(`${ui}/src/shell/Header.tsx`, text).text).toBe(text)
  })

  it("changes nothing in a file already rewritten, at its new place", () => {
    const after = new Set([...tracked].map(placed))
    for (const { dir } of packages) after.add(`${dir}/src/test.ts`)
    for (const file of tracked) {
      if (!/\.(?:tsx?|css)$/.test(file)) continue
      const first = rewrite(file)
      const next = placed(file)
      const again = rewrite(next, first.text, after)
      expect([next, again.problems, again.text]).toEqual([next, [], first.text])
    }
  })
})

describe("the cycle", () => {
  // The Vitest re-export in the test kit, as the README's table would have it: core's tests
  // would import the kit, and the kit imports core.
  const inKit: Policy = {
    place: (file) =>
      file === `${ui}/src/test.ts` ? "frontend/test-kit/src/test.ts" : destinationOf(file),
    ownCopies: [],
  }
  const graph = (rule: Policy): ReturnType<typeof edgesOf> =>
    [
      `${ui}/src/core/store.test.ts`,
      `${ui}/src/test/render.ts`,
      `${ui}/src/test/phases.ts`,
    ].flatMap((file) => {
      const text = (old.get(file) ?? 'import { x } from "#core/store"\n').replace(
        "../test/fixtures",
        "../test",
      )
      const out = rewriteImports(file, text, tracked, rule)
      return edgesOf(rule.place(file) as string, out.text)
    })

  it("is refused when the re-export moves into the test kit", () => {
    const problems = cycleProblem(graph(inKit))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/core -> test-kit -> core|test-kit -> core -> test-kit/)
  })

  it("does not exist while each package keeps its own", () => {
    expect(cycleProblem(graph(policy))).toEqual([])
  })
})

describe("the dependencies, read off the imports", () => {
  const files = new Map([
    [
      "frontend/demo/src/a.ts",
      'import { x } from "@novadeck/core/types"\nimport "lucide-react"\nimport { y } from "@novadeck/emulator/browser"\n',
    ],
    [
      "frontend/demo/src/a.test.ts",
      'import { it } from "vitest"\nimport { render } from "@novadeck/test-kit/render"\nimport "node:fs"\n',
    ],
    ["frontend/demo/src/b.tsx", "export const b = 1\n"],
  ])
  const versions = {
    ...tooling,
    "lucide-react": "^1.55.0",
    "@novadeck/emulator": "workspace:*",
    react: "^19.3.0",
  }
  const pkg = packages.find(({ id }) => id === "demo")!

  it("splits npm and workspace packages by what imports them, tests apart", () => {
    const deps = dependenciesOf(pkg, files, versions)
    expect(deps.problems).toEqual([])
    expect(deps.dependencies).toEqual({
      "@novadeck/core": "workspace:*",
      "@novadeck/emulator": "workspace:*",
      "lucide-react": "^1.55.0",
      react: "^19.3.0",
    })
    expect(deps.devDependencies).toMatchObject({
      "@novadeck/test-kit": "workspace:*",
      vitest: "^5.0.3",
    })
  })

  it("fails on an npm package nothing in the repository gives a version", () => {
    const deps = dependenciesOf(
      pkg,
      new Map([["frontend/demo/src/a.ts", 'import "left-pad"\n']]),
      versions,
    )
    expect(deps.problems).toEqual([expect.stringContaining("imports left-pad")])
  })
})

describe("the plan", () => {
  const names = new Map([["@novadeck/emulator", "workspace:*"]])
  void names
  const run = (tree: ReadonlyMap<string, string>): Planned =>
    plan({
      tracked: [...tree.keys()],
      read: (file) => tree.get(file) ?? "",
      isTextual: (file) => /\.(?:[cm]?[jt]sx?|json|md|css)$/.test(file),
      template: (file) => `// template for ${file}\n`,
      edits: [],
    })
  const withDeps = new Map(old)
  // The tree as the plan leaves it.
  const apply = (tree: ReadonlyMap<string, string>, planned: Planned): Map<string, string> => {
    const next = new Map(tree)
    for (const { from, to } of planned.moves) {
      next.set(to, next.get(from) ?? "")
      next.delete(from)
    }
    for (const file of planned.removes) next.delete(file)
    for (const [file, text] of planned.writes) next.set(file, text)
    return next
  }

  it("moves, rewrites and writes without a problem", () => {
    const planned = run(withDeps)
    expect(planned.problems).toEqual([])
    const after = apply(withDeps, planned)
    expect(after.get("frontend/core/src/store.test.ts")).toContain('from "./testing"')
    expect(after.get("frontend/core/src/test.ts")).toContain("vitest")
    expect(after.get("frontend/ui/src/shell/Header.tsx")).toContain("@novadeck/core/store")
    const manifest = JSON.parse(after.get("frontend/ui/package.json")!) as {
      dependencies: Record<string, string>
      exports: Record<string, string>
    }
    expect(manifest.dependencies).toMatchObject({ "@novadeck/core": "workspace:*", clsx: "^2.1.1" })
    expect(manifest.exports["./app/App"]).toBe("./src/app/App.tsx")
    const adapter = JSON.parse(after.get("frontend/runner-adapter/package.json")!) as {
      exports: Record<string, unknown>
    }
    expect(Object.keys(adapter.exports)).toEqual([".", "./conversations", "./scripted-server"])
    expect(after.get("frontend/ui/vite.config.ts")).toContain(
      "template for frontend/ui/vite.config.ts",
    )
  })

  it("exports the file another package imports, and nothing it doesn't name", () => {
    const tree = new Map(withDeps)
    tree.set(
      `${ui}/src/specs/a.spec.tsx`,
      'import { Header } from "../shell/Header"\nexport const a = Header\n',
    )
    tree.set(`${ui}/src/shell/Other.tsx`, "export const o = 1\n")
    const after = apply(tree, run(tree))
    const exported = (JSON.parse(after.get("frontend/ui/package.json")!) as { exports: object })
      .exports
    expect(exported).toHaveProperty(["./shell/Header"], "./src/shell/Header.tsx")
    expect(exported).not.toHaveProperty(["./shell/Other"])
  })

  it("makes the tree so: a second plan changes nothing, and a branch's addition is moved", () => {
    const once = apply(withDeps, run(withDeps))
    const second = run(once)
    expect(second.problems).toEqual([])
    expect([second.moves, second.removes, [...second.writes.keys()]]).toEqual([[], [], []])
    // A file a branch added at the old place, importing the old way.
    const branch = new Map(once)
    branch.set(
      `${ui}/src/shell/Footer.tsx`,
      'import { store } from "#core/store"\nexport const Footer = store\n',
    )
    const third = run(branch)
    expect(third.problems).toEqual([])
    expect(third.moves).toEqual([
      { from: `${ui}/src/shell/Footer.tsx`, to: "frontend/ui/src/shell/Footer.tsx" },
    ])
    expect(apply(branch, third).get("frontend/ui/src/shell/Footer.tsx")).toContain(
      "@novadeck/core/store",
    )
  })

  it("stops when a file is tracked at both places, or in a folder no package takes", () => {
    const both = new Map(withDeps).set("frontend/ui/src/shell/Header.tsx", "x")
    expect(run(both).problems.join()).toContain("both tracked")
    const loose = new Map(withDeps).set(`${ui}/src/backend/newadapter/a.ts`, "x")
    expect(run(loose).problems.join()).toContain("no package takes")
  })

  it("stops when a replaced file isn't the text its template was written for", () => {
    const tree = new Map(withDeps).set(`${ui}/vite.config.ts`, "// someone's change\n")
    expect(run(tree).problems.join()).toContain("redo its template")
  })
})

describe("the packages table", () => {
  it("places every package's folder and name, and no package inside another's", () => {
    for (const pkg of packages) {
      expect(packageOf(`${pkg.dir}/src/x.ts`)).toBe(pkg)
      expect(pkg.name).toMatch(/^@novadeck\/[a-z-]+$/)
    }
    expect(new Set(packages.map(({ dir }) => dir)).size).toBe(packages.length)
  })
})

describe("paths named in text", () => {
  it("points a path below the old UI at the package that holds it", () => {
    expect(rewritePaths("see application/ui/src/core/store.ts")).toBe(
      "see frontend/core/src/store.ts",
    )
    expect(rewritePaths("`application/ui/src/backend/runner/index.ts`")).toBe(
      "`frontend/runner-adapter/src/index.ts`",
    )
    expect(rewritePaths("budgets=application/ui/src/specs/counters/budgets.json")).toBe(
      "budgets=frontend/specs/src/counters/budgets.json",
    )
    expect(rewritePaths("path: application/ui/test-results/counters.json")).toBe(
      "path: frontend/specs/test-results/counters.json",
    )
    expect(rewritePaths("application/ui/src/backend/demo/showcase/plans/*.md text")).toBe(
      "frontend/demo/src/showcase/plans/*.md text",
    )
    expect(rewritePaths('dir: "application/ui",')).toBe('dir: "frontend/ui",')
    expect(rewritePaths('new URL("../../application/ui/", import.meta.url)')).toBe(
      'new URL("../../frontend/ui/", import.meta.url)',
    )
    expect(rewritePaths("`ui/src/core/process.ts` and")).toBe("`frontend/core/src/process.ts` and")
  })

  it("keeps the folder's last slash as it was written, and a regular expression's escapes", () => {
    expect(pathBelowUi("src/backend/runner/")).toBe("frontend/runner-adapter/src/")
    expect(pathBelowUi("src/backend/runner")).toBe("frontend/runner-adapter/src")
    expect(rewritePaths(String.raw`/\/application\/ui\/src\/shell\//`)).toBe(
      String.raw`/\/frontend\/ui\/src\/shell\//`,
    )
  })

  it("leaves a folder that several packages now share, for the leftover check", () => {
    for (const text of ["application/ui/src", "application/ui/src/", "application/ui/src/backend/"])
      expect(rewritePaths(text)).toBe(text)
    expect(leftovers("README.md", "Source lives in application/ui/src/, grouped")).toHaveLength(1)
  })

  it("leaves what only looks like one", () => {
    for (const text of [
      "/w/repo/application/ui/orders.ts",
      "application/uix",
      "tui/src/bottom_pane",
    ])
      expect(rewritePaths(text)).toBe(text)
  })

  it("changes nothing a second time", () => {
    const once = rewritePaths(
      'application/ui/src/core/store.ts, `ui/src/specs/x`, "application/ui"',
    )
    expect(rewritePaths(once)).toBe(once)
  })

  it("finds the old UI however it's written, outside what keeps it on purpose", () => {
    const text = [
      'join(root, "application", "ui", "dist")',
      "see application/ui/dist",
      "import x from '#core/types'",
    ].join("\n")
    expect(leftovers("docs/x.md", text)).toHaveLength(3)
    expect(leftovers("scripts/flakes/fixtures/run.txt", text)).toEqual([])
    expect(leftovers(".github/workflows/try.yml", text)).toEqual([])
  })
})

describe("the handwritten edits", () => {
  it("make themselves once: the text they leave is already made, and is left alone", () => {
    for (const edit of edits) {
      const text = `before ${edit.before} after`
      const made = applyEdit(text, edit)
      if ("problem" in made) throw new Error(made.problem)
      const again = applyEdit(made.text, edit)
      expect(again).toEqual({ text: made.text, state: "there" })
    }
  })
})

describe("what a branch added to the old UI's manifest", () => {
  const generated = JSON.stringify({
    name: "@novadeck/ui",
    scripts: { dev: "vite", test: "vitest run" },
    dependencies: { react: "^19.3.0" },
    devDependencies: { vitest: "^5.0.3" },
  })

  it("keeps a script and a dependency the branch added, and drops what main had and the split moves", () => {
    const before = JSON.stringify({
      name: "@novadeck/ui",
      scripts: {
        dev: "vite",
        "poster:try": "node scripts/poster.ts",
        "lint:stale": "oxlint stale",
      },
      dependencies: { "@novadeck/wire": "workspace:*", "left-pad": "^1.0.0" },
      devDependencies: { "stale-tool": "^2.0.0", playwright: "^1.64.0" },
    })
    const { text, problems } = withBranchAdditions(generated, before, "application/ui/package.json")
    const made = JSON.parse(text) as Record<string, Record<string, string>>
    expect(problems).toEqual([])
    expect(made.scripts).toEqual({ dev: "vite", test: "vitest run", "lint:stale": "oxlint stale" })
    expect(made.dependencies).toEqual({ "left-pad": "^1.0.0", react: "^19.3.0" })
    expect(made.devDependencies).toEqual({ "stale-tool": "^2.0.0", vitest: "^5.0.3" })
  })

  it("stops on a field the generated manifest has no place for", () => {
    const before = JSON.stringify({ name: "@novadeck/ui", sideEffects: false })
    expect(withBranchAdditions(generated, before, "application/ui/package.json").problems).toEqual([
      expect.stringContaining('the field "sideEffects"'),
    ])
  })

  it("is part of the plan, so a branch's script is in the package after the move", () => {
    const tree = new Map(old)
    tree.set(
      `${ui}/package.json`,
      JSON.stringify({
        name: "@novadeck/ui",
        scripts: { "lint:stale": "oxlint stale" },
        dependencies: { react: "^19.3.0", clsx: "^2.1.1" },
        devDependencies: tooling,
      }),
    )
    const planned = plan({
      tracked: [...tree.keys()],
      read: (file) => tree.get(file) ?? "",
      isTextual: (file) => /\.(?:[cm]?[jt]sx?|json|md|css)$/.test(file),
      template: (file) => `// template for ${file}\n`,
      edits: [],
    })
    expect(planned.problems).toEqual([])
    const manifest = JSON.parse(planned.writes.get("frontend/ui/package.json")!) as {
      scripts: Record<string, string>
    }
    expect(manifest.scripts["lint:stale"]).toBe("oxlint stale")
  })
})

describe("what a failed run leaves to clean", () => {
  it("is the packages' folders and each file written elsewhere, from the written list", () => {
    expect(
      cleanPaths([
        "frontend/core/src/a.ts",
        "frontend/ui/package.json",
        "apps/try/index.html",
        "tools/build-kit/src/vitest.ts",
        "scripts/flakes/specs-path.test.ts",
      ]),
    ).toEqual([
      "frontend",
      "apps",
      "tools/build-kit/src/vitest.ts",
      "scripts/flakes/specs-path.test.ts",
    ])
  })
})

describe("the other ways a file names a path", () => {
  const adapter = packages.find(({ id }) => id === "runner-adapter")!
  const file = `${ui}/src/backend/runner/a.ts`

  it("stops on a glob, a URL from the module's own or a url() that reaches another package", () => {
    expect(
      crossPathProblems(file, 'const all = import.meta.glob("../terminal-views/*.ts")', adapter),
    ).toEqual([expect.stringContaining("import.meta.glob")])
    expect(
      crossPathProblems(
        file,
        'const u = new URL("../terminal-views/mount.ts", import.meta.url)',
        adapter,
      ),
    ).toEqual([expect.stringContaining("new URL")])
    expect(
      crossPathProblems(
        `${ui}/src/shell/a.css`,
        "a { background: url(../backend/demo/x.svg) }",
        packages.find(({ id }) => id === "ui")!,
      ),
    ).toEqual([expect.stringContaining("url()")])
  })

  it("lets one that stays in its package, or isn't relative, alone", () => {
    expect(crossPathProblems(file, 'import.meta.glob("./*.ts")', adapter)).toEqual([])
    expect(crossPathProblems(file, 'new URL("voice.js", document.baseURI)', adapter)).toEqual([])
    expect(crossPathProblems(file, 'new URL("./x.js", import.meta.url)', adapter)).toEqual([])
  })

  it("is part of the import rewrite", () => {
    const stops = rewrite(file, 'const all = import.meta.glob("../terminal-views/*.ts")')
    expect(stops.problems).toHaveLength(1)
  })
})

describe("the small things", () => {
  it("names a package without its query", () => {
    expect(packageName("@novadeck/runner-adapter?url")).toBe("@novadeck/runner-adapter")
  })

  it("sends the apps' pages and builds named in text to the apps", () => {
    expect(rewritePaths("(`application/ui/entries/try/`) and `application/ui/dist-try`")).toBe(
      "(`apps/try/`) and `apps/try/dist`",
    )
    expect(leftovers("README.md", "see frontend/ui/entries/try/ here")).toHaveLength(1)
    expect(leftovers("README.md", "see frontend/ui/entries/web/ here")).toEqual([])
  })
})

// Written from parts, so no line of this file starts a conflict marker.
const opening = "<".repeat(7)
const closing = ">".repeat(7)

describe("what a branch changed in a script, an import or a version", () => {
  const generated = JSON.stringify({
    name: "@novadeck/ui",
    type: "module",
    scripts: { dev: "vite", "test:watch": "vitest" },
    dependencies: { react: "^19.3.0" },
    devDependencies: { playwright: "^1.64.0", vite: "^7.3.6" },
  })
  const made = (before: object) =>
    JSON.parse(withBranchAdditions(generated, JSON.stringify(before), "p.json").text) as Record<
      string,
      Record<string, string>
    >

  it("keeps the branch's command for a script main had, and main's for one it left alone", () => {
    const { scripts } = made({
      scripts: { "test:watch": "vitest --ui", dev: "vite --host 127.0.0.1" },
    })
    expect(scripts!["test:watch"]).toBe("vitest --ui")
    expect(scripts!.dev).toBe("vite")
  })

  it("keeps an import the branch added to the old manifest", () => {
    const manifest = made({
      imports: { "#core/*": "./src/core/*.ts", "#extra/*": "./src/extra/*.ts" },
    })
    expect(manifest.imports).toEqual({ "#extra/*": "./src/extra/*.ts" })
  })

  it("keeps the branch's version of a dependency main had, the host's listed ones among them", () => {
    const manifest = made({
      devDependencies: { playwright: "^1.65.0", vite: "^7.3.6" },
      dependencies: { react: "^19.4.0" },
    })
    expect(manifest.devDependencies).toEqual({ playwright: "^1.65.0", vite: "^7.3.6" })
    expect(manifest.dependencies).toEqual({ react: "^19.4.0" })
  })

  it("takes the old UI's version for a package the host lists first", () => {
    const tree = new Map(old)
    tree.set(
      "application/host/package.json",
      JSON.stringify({ name: "@novadeck/host", devDependencies: { vite: "^6.0.0" } }),
    )
    const planned = plan({
      tracked: [...tree.keys()],
      read: (file) => tree.get(file) ?? "",
      isTextual: (file) => /\.(?:[cm]?[jt]sx?|json|md|css)$/.test(file),
      template: () => "",
      edits: [],
    })
    const manifest = JSON.parse(planned.writes.get("frontend/ui/package.json")!) as {
      devDependencies: Record<string, string>
    }
    expect(manifest.devDependencies.vite).toBe(tooling.vite)
  })

  it("stops on a manifest that isn't JSON, with a message, not a SyntaxError", () => {
    const tree = new Map(old).set(
      `${ui}/package.json`,
      `{\n"name": "@novadeck/ui",\n"scripts": {\n${opening} ours\n}\n`,
    )
    const planned = plan({
      tracked: [...tree.keys()],
      read: (file) => tree.get(file) ?? "",
      isTextual: (file) => /\.(?:[cm]?[jt]sx?|json|md|css)$/.test(file),
      template: () => "",
      edits: [],
    })
    expect(planned.problems.join()).toContain("isn't JSON")
  })
})

describe("merging a manifest key by key", () => {
  const base = {
    name: "u",
    version: "0.0.0",
    scripts: { dev: "vite", preview: "vite preview" },
    dependencies: { a: "1" },
  }

  it("keeps what each side changed, and sorts the dependencies", () => {
    const ours = {
      ...base,
      scripts: { ...base.scripts, "lint:stale": "x" },
      dependencies: { a: "1", zod: "4" },
    }
    const theirs = {
      ...base,
      version: "0.1.0",
      scripts: { ...base.scripts, preview: "vite preview --port 1", "lint:main": "y" },
      dependencies: { a: "1", "@novadeck/relay": "workspace:*" },
    }
    const merged = mergeManifests(ours, base, theirs)
    expect(merged.conflicts).toEqual([])
    expect(JSON.parse(merged.text)).toEqual({
      name: "u",
      version: "0.1.0",
      scripts: {
        dev: "vite",
        preview: "vite preview --port 1",
        "lint:stale": "x",
        "lint:main": "y",
      },
      dependencies: { "@novadeck/relay": "workspace:*", a: "1", zod: "4" },
    })
  })

  it("names a key both sides changed differently, and keeps main's", () => {
    const merged = mergeManifests({ ...base, version: "0.2.0" }, base, {
      ...base,
      version: "0.1.0",
    })
    expect(merged.conflicts).toEqual(["version"])
    expect(JSON.parse(merged.text).version).toBe("0.1.0")
    const script = mergeManifests({ ...base, scripts: { ...base.scripts, dev: "a" } }, base, {
      ...base,
      scripts: { ...base.scripts, dev: "b" },
    })
    expect(script.conflicts).toEqual(["scripts.dev"])
  })
})

describe("conflict markers", () => {
  it("are the lines that start with seven angle brackets and a space, either way", () => {
    const text = ["a", `${opening} ours`, "b", "=======", "c", `${closing} theirs`].join("\n")
    expect(conflictMarkers(text)).toEqual([2, 6])
    expect(conflictMarkers("Title\n=======\ntext <<<<<<< not at the start")).toEqual([])
  })
})

describe("more path forms", () => {
  const adapter = packages.find(({ id }) => id === "runner-adapter")!
  const file = `${ui}/src/backend/runner/a.ts`

  it("stops on a backtick literal and on a root-absolute glob into another package", () => {
    expect(
      crossPathProblems(file, "const all = import.meta.glob(`../terminal-views/*.ts`)", adapter),
    ).toHaveLength(1)
    expect(
      crossPathProblems(file, "new URL(`../terminal-views/x.js`, import.meta.url)", adapter),
    ).toHaveLength(1)
    expect(
      crossPathProblems(file, 'import.meta.glob("/src/backend/demo/*.ts")', adapter),
    ).toHaveLength(1)
    expect(
      crossPathProblems(file, 'import.meta.glob("/src/backend/runner/*.ts")', adapter),
    ).toEqual([])
  })
})
