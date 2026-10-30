import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { order } from "./order.ts"

const root = join(import.meta.dirname, "..", "..")

// The fence around libraries/ and the UI's browser code. Package names are hardly in it: the
// package graph (graph.ts) refuses a library's dependency on an app package or an unordered
// library, and pnpm refuses an undeclared one, but for the root's own dependencies, which
// resolve from anywhere. What stays is those, paths, which bypass package.json, and the
// Node-only subpaths and built-ins of browser code. When several overrides match a file,
// oxlint takes `no-restricted-imports` from the last one alone, dropping the earlier ones'
// lists, so the override for test support repeats the browser code's other bans. Reading the config
// can't show what a file ends up with, so this lints probe files at those paths with the real
// config and reads back which of their imports oxlint refuses.

const names = Object.keys(order)
const config = JSON.parse(readFileSync(join(root, ".oxlintrc.json"), "utf8")) as {
  readonly overrides: readonly {
    readonly files: readonly string[]
    readonly rules?: {
      readonly "no-restricted-imports"?: readonly [
        string,
        { readonly paths?: readonly { readonly name: string }[] }?,
      ]
    }
  }[]
}

// Relative paths out of a library, which no package.json sees.
const app = [
  "../../../../backend/runner/src/manager.ts",
  "../../../../contract/protocol/src/index.ts",
  "../../../../frontend/ui/src/index.ts",
  "../../../../apps/desktop/src/main/index.ts",
  "../../../../harnesses/core/src/harness.ts",
  "../../../../libraries/wire/src/index.ts",
  // A sibling's build, which a declaration file lets typecheck, as no rootDir sees it.
  "../../wire/dist/index.js",
  "../../wire/dist",
  "../../../../atlas/src/index.ts",
  // A folder named alone, its package's entry.
  "../../../../atlas",
  "../../../../tools/atlas",
  "../../../../backend",
  "../../../../contract",
  "../../../../frontend",
  "../../../../apps",
  "../../../../harnesses",
  "../../../../libraries",
]
const library = (name: string) => [`@novadeck/${name}`, `@novadeck/${name}/sub`]
// The workspace packages the root itself depends on, which pnpm links at the root's
// node_modules, so they resolve from every package without its declaring them: the fence
// refuses them by name.
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}
const rootLinked = Object.entries({
  ...rootManifest.dependencies,
  ...rootManifest.devDependencies,
})
  .filter(([, version]) => version.startsWith("workspace:"))
  .flatMap(([name]) => [name, `${name}/sub`])
const node = [
  ...["pty", "host", "server", "electron", "browser/host", "shell"].map(
    (sub) => `@novadeck/terminal/${sub}`,
  ),
  "@novadeck/emulator/headless",
]
// Node's built-ins, in each form they are written: with node: and without.
const builtins = ["node:fs", "node:fs/promises", "node:worker_threads", "fs", "path/posix"]
const browser = [
  "@novadeck/emulator/browser",
  "@novadeck/emulator/browser.css",
  "@novadeck/emulator/width",
  "@novadeck/terminal",
  "@novadeck/terminal/view",
  "@novadeck/wire/client",
  "@novadeck/viewers/browser",
]
// A module of its own may share a name with a workspace folder.
const own = [
  "./sibling.ts",
  "../index.ts",
  "./atlas",
  "./backend",
  "./contract",
  "./frontend",
  "./apps",
  // Step 5's folders are refused only as paths out of the library: its own folders by those
  // names, and a package's subpath that names one, stay its own.
  "./contract/index.ts",
  "@orpc/contract/plugins",
  "@xterm/xterm",
  // A package's own build, as its stylesheets are imported.
  "katex/dist/katex.min.css",
]

/** How a probe writes an import: each form the fence must see. */
type Form = "import" | "type" | "export" | "named" | "dynamic"
// Each binding its own, as a file that declares one twice doesn't parse, and isn't linted.
const write: Readonly<Record<Form, (name: string, index: number) => string>> = {
  import: (name) => `import "${name}"\n`,
  type: (name, index) => `import type * as types${index} from "${name}"\n`,
  export: (name) => `export * from "${name}"\n`,
  named: (name) => `export { default } from "${name}"\n`,
  dynamic: (name) => `await import("${name}")\n`,
}

/**
 * The probes: a file path, everything it imports and in what form, and what the fence must
 * refuse. A relative import into a sibling library's sources that names no folder
 * (`../../wire/src`) isn't among them: the lint can't tell it from the library's own, and
 * the library's rootDir fails its typecheck instead.
 */
const probes = [
  ...names.flatMap((name) => {
    // Any library's name may be imported here, but the root's: the package graph holds the order.
    const imports = [...app, ...names.flatMap(library), ...rootLinked, ...own, "node:path"]
    return (
      [
        [`libraries/${name}/src/probe.ts`, "import"],
        [`libraries/${name}/src/types.ts`, "type"],
        [`libraries/${name}/src/deep/probe.test.ts`, "export"],
        [`libraries/${name}/src/deep/named.ts`, "named"],
        [`libraries/${name}/src/deep/dynamic.ts`, "dynamic"],
      ] as const
    ).map(([file, form]) => ({ file, form, imports, refused: [...app, ...rootLinked] }))
  }),
  // A library not in the order yet is fenced the same.
  {
    file: "libraries/unlisted/src/probe.ts",
    form: "import" as Form,
    imports: [...app, ...names.flatMap(library), ...rootLinked, ...own, "node:path"],
    refused: [...app, ...rootLinked],
  },
  ...(
    [
      ["frontend/ui/src/probe.ts", "import", true],
      ["frontend/ui/src/types.ts", "type", true],
      ["frontend/ui/src/deep/probe.test.tsx", "export", false],
      ["frontend/ui/src/deep/named.ts", "named", true],
      ["frontend/ui/src/deep/dynamic.ts", "dynamic", true],
      ["apps/try/src/probe.ts", "import", true],
      ["apps/previews/src/probe.ts", "import", true],
      ["apps/desktop/renderer/probe.ts", "import", true],
      // Test support, which runs in Node and stays out of the build.
      ["frontend/runner-adapter/src/testing/runner.ts", "import", false],
      ["frontend/test-kit/src/phases.ts", "import", false],
      ["frontend/test-kit/src/other.ts", "import", true],
      ["apps/try/src/deploy.test.ts", "import", false],
    ] as const
  ).map(([file, form, noBuiltins]) => ({
    file,
    form,
    imports: [
      ...node,
      ...builtins,
      ...rootLinked,
      ...browser,
      "../../../../libraries/terminal/src/view.ts",
      "../../../../libraries",
      "./libraries",
      ...own,
    ],
    refused: [
      ...node,
      ...(noBuiltins ? builtins : []),
      ...rootLinked,
      "../../../../libraries/terminal/src/view.ts",
      "../../../../libraries",
    ],
  })),
]

let refusals: ReadonlyMap<string, readonly string[]> = new Map()
let workspace = ""

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "novadeck-fence-"))
  writeFileSync(join(workspace, ".oxlintrc.json"), readFileSync(join(root, ".oxlintrc.json")))
  for (const { file, form, imports } of probes) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true })
    writeFileSync(join(workspace, file), imports.map(write[form]).join(""))
  }
  const oxlint = join(root, "node_modules", "oxlint", "bin", "oxlint")
  // oxlint exits non-zero on the refusals it's here to find.
  const output = (() => {
    try {
      return execFileSync(process.execPath, [oxlint, "--format", "json", "."], {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (error) {
      // Only what it printed counts: one that couldn't run printed nothing.
      const { stdout } = error as { stdout?: string }
      if (!stdout) throw error
      return stdout
    }
  })()
  const { diagnostics } = JSON.parse(output) as {
    diagnostics: readonly { code: string; message: string; filename: string }[]
  }
  const found = new Map<string, string[]>()
  for (const { code, message, filename } of diagnostics) {
    const name = /^'(.+)' import is restricted/.exec(message)?.[1]
    if (code !== "eslint(no-restricted-imports)" || !name) continue
    const file = filename.replaceAll("\\", "/")
    found.set(file, [...(found.get(file) ?? []), name])
  }
  refusals = found
})

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe("the libraries' lint fence", () => {
  it("finds the root's workspace packages", () => {
    expect(rootLinked).toEqual(expect.arrayContaining(["@novadeck/sandbox"]))
  })

  it("knows the order of every library in libraries/", () => {
    const folders = existsSync(join(root, "libraries"))
      ? readdirSync(join(root, "libraries")).filter((name) =>
          existsSync(join(root, "libraries", name, "package.json")),
        )
      : []
    expect(names).toEqual(expect.arrayContaining(folders))
  })

  // oxlint takes a folder's own config in place of the root's, not on top of it, so one in
  // a fenced folder or a folder above one would lift the fence there, which the probes, under
  // the root's alone, can't see.
  it("has no oxlint config but the root's to lift it", () => {
    // The files git would track, as oxlint lints them: what .gitignore leaves out, as other
    // checkouts and builds, holds no config of this tree's.
    const configs = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      // Each name as it is, unquoted, whatever it holds.
      .split("\0")
      .filter(
        (path) =>
          path !== ".oxlintrc.json" &&
          /(?:^|\/)(?:\.oxlintrc[^/]*|oxlint\.config\.[^/]+)$/.test(path),
      )
    expect(configs).toEqual([])
  })

  it.each(probes.filter(({ file }) => file.startsWith("libraries/")))(
    "refuses $file exactly the paths out of the library and the root's packages",
    ({ file, refused }) => {
      expect([...new Set(refusals.get(file))].toSorted()).toEqual(refused.toSorted())
    },
  )
})

describe("the browser code's lint fence", () => {
  // A bare built-in is an exact name, as `path` in a pattern would match `@scope/path` too:
  // the override lists each, which this keeps to Node's own list.
  it("names every Node built-in its prefix may be left off", () => {
    const fence = config.overrides.find((each) => each.files.includes("frontend/*/src/**"))
    const [, rule] = fence?.rules?.["no-restricted-imports"] ?? []
    const listed = new Set((rule?.paths ?? []).map(({ name }) => name))
    expect(
      builtinModules.filter(
        (name) => !name.startsWith("_") && !name.startsWith("node:") && !listed.has(name),
      ),
    ).toEqual([])
  })

  it.each(probes.filter(({ file }) => !file.startsWith("libraries/")))(
    "refuses $file exactly the libraries' Node subpaths, paths into libraries/, the root's packages and, but for test support, Node built-ins",
    ({ file, refused }) => {
      expect([...new Set(refusals.get(file))].toSorted()).toEqual(refused.toSorted())
    },
  )
})
