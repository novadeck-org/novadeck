import { describe, expect, it } from "vitest"

import { destinationOf, edits, leftovers, rewritable, rewrite, rows } from "./backend.ts"
import { applyEdit } from "./move.ts"

describe("where 5.3a moves a file", () => {
  it("takes each folder's files to its new place, and no other folder's", () => {
    expect(destinationOf("application/runner/src/cli.ts")).toBe("backend/runner/src/cli.ts")
    expect(destinationOf("application/runner-client/src/index.ts")).toBe(
      "contract/runner-client/src/index.ts",
    )
    expect(destinationOf("application/relay/Cargo.toml")).toBe("backend/relay/Cargo.toml")
    expect(destinationOf("application/protocol/package.json")).toBe(
      "contract/protocol/package.json",
    )
    expect(destinationOf("atlas/extract/main.ts")).toBe("tools/atlas/extract/main.ts")
    expect(destinationOf("application/ui/src/App.tsx")).toBeUndefined()
    expect(destinationOf("tools/atlas/extract/main.ts")).toBeUndefined()
    expect(destinationOf("application/runnerx/a.ts")).toBeUndefined()
  })
})

describe("the rewrite", () => {
  it("points a path from the root at the new place, in each way it is quoted", () => {
    expect(rewrite("      - application/runner/**")).toBe("      - backend/runner/**")
    expect(rewrite('hashFiles("application/relay/Cargo.lock")')).toBe(
      'hashFiles("backend/relay/Cargo.lock")',
    )
    expect(rewrite("see `application/protocol`.")).toBe("see `contract/protocol`.")
    expect(rewrite("working-directory: application/relay")).toBe("working-directory: backend/relay")
    expect(rewrite('require("./application/runner/src/e2e/harnesses.json")')).toBe(
      'require("./backend/runner/src/e2e/harnesses.json")',
    )
  })

  it("keeps a relative path's depth, as the folders keep theirs", () => {
    expect(
      rewrite('new URL("../../../application/runner/src/e2e/install.ts", import.meta.url)'),
    ).toBe('new URL("../../../backend/runner/src/e2e/install.ts", import.meta.url)')
  })

  it("tells the runner from the runner client", () => {
    expect(rewrite("application/runner-client/src/index.ts and application/runner/src")).toBe(
      "contract/runner-client/src/index.ts and backend/runner/src",
    )
  })

  it("rewrites a regular expression's escaped form", () => {
    expect(rewrite(String.raw`toMatch(/under application\/runner\/src\/terminals\//)`)).toBe(
      String.raw`toMatch(/under backend\/runner\/src\/terminals\//)`,
    )
    expect(rewrite(String.raw`/\/application\/runner-client\/(?:src|dist)\//`)).toBe(
      String.raw`/\/contract\/runner-client\/(?:src|dist)\//`,
    )
  })

  it("moves the atlas only from the root, never a fence's `../atlas` or a module's own", () => {
    expect(rewrite("[atlas/AGENTS.md](atlas/AGENTS.md)")).toBe(
      "[tools/atlas/AGENTS.md](tools/atlas/AGENTS.md)",
    )
    expect(rewrite('"**/../atlas", "**/atlas/**", "./atlas", "@novadeck/atlas/x"')).toBe(
      '"**/../atlas", "**/atlas/**", "./atlas", "@novadeck/atlas/x"',
    )
    expect(rewrite("src/generated/atlas.json")).toBe("src/generated/atlas.json")
    // The atlas's data and a glyph atlas are no paths.
    for (const text of [
      "import { atlas, groupBy } from",
      "the glyph atlas.",
      "(atlas)",
      "atlas: 47 areas",
    ])
      expect(rewrite(text)).toBe(text)
  })

  it("leaves what only looks like one: another folder, a name, an absolute path's middle", () => {
    for (const text of [
      "application/ui/src/App.tsx",
      "application/runnerx",
      "@novadeck/runner",
      "/w/repo/application/runner",
      "**/../application",
    ])
      expect(rewrite(text)).toBe(text)
  })

  it("takes a markdown anchor or a query, but not another file or a wider glob", () => {
    expect(rewrite("[the relay](application/relay#build)")).toBe("[the relay](backend/relay#build)")
    expect(rewrite("see application/relay.\nOr application/relay.")).toBe(
      "see backend/relay.\nOr backend/relay.",
    )
    for (const text of ["application/runner.ts", "application/runner*"])
      expect(rewrite(text)).toBe(text)
  })

  it("changes nothing a second time, for every folder in every form", () => {
    const once = rewrite(
      rows
        .flatMap(({ from }) => [
          `"${from}/a.ts"`,
          `\`${from}\``,
          `../../${from}/b`,
          ` ${from.replaceAll("/", "\\/")}\\/c`,
          `\\/${from.replaceAll("/", "\\/")}\\/d`,
          `[x](${from}#y)`,
        ])
        .join("\n"),
    )
    expect(rewrite(once)).toBe(once)
    expect(once).not.toMatch(/tools\/tools|tools\\\/tools/)
  })

  it("keeps the atlas's escaped form from the root alone, off tools/'s and a glyph atlas's", () => {
    for (const text of [String.raw`\/tools\/atlas\/`, String.raw`\/libraries\/emulator\/atlas\/`])
      expect(rewrite(text)).toBe(text)
  })
})

describe("the handwritten edits", () => {
  // An edit is done once its old text is gone: one whose new text held its old would be made
  // again on every run.
  it("each leave nothing of their old text behind", () => {
    for (const edit of edits) {
      const made = applyEdit(edit.before, edit)
      expect("text" in made && made.text.includes(edit.before), edit.why).toBe(false)
      expect("text" in made && applyEdit(made.text, edit), edit.why).toMatchObject({
        state: "there",
      })
    }
  })
})

describe("what the move leaves", () => {
  it("finds an old folder however it's written, outside what keeps one on purpose", () => {
    const text = [
      'join(root, "application", "runner", "dist")',
      "join(root, 'application', 'relay')",
      "a prose application/relay mention",
      "C:/novadeck/application/protocol",
      "'^(application/(ui|runner|protocol)/|",
      "application/{runner,relay}/**",
      "application/*/src and `application/${name}`",
      "cd atlas && ls",
      "!atlas/**",
      'join(root, "atlas", "package.json")',
      "https://github.com/o/r/blob/main/atlas/AGENTS.md",
      String.raw`atlas\extract\main.ts`,
      "fine: backend/runner and tools/atlas/x, application/* and **/application/**",
    ].join("\n")
    expect(leftovers("docs/x.md", text)).toHaveLength(12)
    expect(leftovers("scripts/flakes/fixtures/run.txt", text)).toEqual([])
  })

  it("follows a relative path from its file, or its package, to an old folder", () => {
    // A config at its package's root: the host's `../runner` was the runner.
    expect(
      leftovers("application/host/electron.vite.config.ts", 'resolve("../runner/src")'),
    ).toHaveLength(1)
    expect(leftovers("application/host/x.yml", "  - from: ../relay/dist")).toHaveLength(1)
    expect(leftovers("application/ui/tsconfig.json", '{ "path": "../protocol" }')).toHaveLength(1)
    // A sibling folder of the same name is its own.
    expect(
      leftovers("application/ui/src/backend/demo/x.ts", 'import "../runner/mount.ts"'),
    ).toEqual([])
    expect(leftovers("backend/runner/src/x/y.ts", 'import "../relay/z.ts"')).toEqual([])
  })

  it("finds a path out of the atlas written for the depth it had", () => {
    expect(leftovers("tools/atlas/extract/x.ts", '"../../application/ui/src"')).toHaveLength(1)
    expect(leftovers("tools/atlas/extract/x.ts", '"../../../application/ui/src"')).toEqual([])
  })

  it("reads text files, outside what keeps an old path", () => {
    expect(rewritable(".github/workflows/e2e.yml")).toBe(true)
    expect(rewritable("backend/relay/src/main.rs")).toBe(true)
    expect(rewritable(".gitattributes")).toBe(true)
    expect(rewritable("application/ui/public/icon.png")).toBe(false)
    expect(rewritable("pnpm-lock.yaml")).toBe(false)
  })
})
