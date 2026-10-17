import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it, onTestFinished } from "vitest"

import { browserEntries, checkLibrary, libraries } from "./browser.ts"
import { template } from "./template.ts"

const root = join(import.meta.dirname, "..", "..")
const fixture = (name: string) => join(import.meta.dirname, "fixtures", name)
const versions = { "@types/node": "^26.6.5", typescript: "^7.0.2", vitest: "^5.0.3" }

describe("a library's browser subpaths", () => {
  it("are every export but those only Node may import", () => {
    expect(
      browserEntries({
        name: "@fixture/any",
        exports: {
          ".": {
            development: "./src/index.ts",
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
          "./view": {
            types: "./dist/view.d.ts",
            browser: "./dist/view.js",
            node: "./dist/node.js",
          },
          "./pty": { node: { development: "./src/pty.ts", default: "./dist/pty.js" } },
        },
      }),
    ).toEqual([
      { subpath: ".", file: "./src/index.ts" },
      { subpath: "./view", file: "./dist/view.js" },
    ])
  })

  it("take a condition's fallbacks, and the next condition where one leads nowhere", () => {
    expect(
      browserEntries({
        name: "@fixture/any",
        exports: {
          "./view": ["./src/view.ts"],
          "./pty": { development: { node: "./src/pty.ts" }, default: "./dist/pty.js" },
          "./host": { browser: null, default: "./dist/host.js" },
        },
      }),
    ).toEqual([
      { subpath: "./view", file: "./src/view.ts" },
      { subpath: "./pty", file: "./dist/pty.js" },
    ])
  })

  it("are the root alone where the exports name a single file", () => {
    expect(browserEntries({ name: "@fixture/any", exports: "./src/index.ts" })).toEqual([
      { subpath: ".", file: "./src/index.ts" },
    ])
  })
})

describe("the browser build check", () => {
  it("passes a library whose browser subpaths stay in the browser", async () => {
    expect(await checkLibrary(fixture("clean"))).toEqual([])
  })

  it("fails on a Node built-in reached through another module", async () => {
    expect(await checkLibrary(fixture("builtin"))).toEqual([
      expect.objectContaining({
        library: "@fixture/builtin",
        subpath: "./view",
        problem: expect.stringContaining("node:os"),
      }),
    ])
  })

  it("fails on a native module", async () => {
    expect(await checkLibrary(fixture("native"))).toEqual([
      expect.objectContaining({ subpath: ".", problem: expect.stringContaining("native module") }),
    ])
  })

  it("fails on a native module known by its binding.gyp alone", async () => {
    expect(await checkLibrary(fixture("gyp"))).toEqual([
      expect.objectContaining({ subpath: ".", problem: expect.stringContaining("native module") }),
    ])
  })

  it("fails on a package the browser bundle can't resolve", async () => {
    expect(await checkLibrary(fixture("unresolved"))).toEqual([
      expect.objectContaining({ problem: expect.stringContaining("missing-optional-peer") }),
    ])
  })

  it("fails a library with no exports, which can't tell browser from Node", async () => {
    expect(await checkLibrary(fixture("unexported"))).toEqual([
      expect.objectContaining({ problem: "package.json has no exports" }),
    ])
  })

  it("fails a library whose every subpath is null, which exports nothing", async () => {
    expect(await checkLibrary(fixture("null-exports"))).toEqual([
      expect.objectContaining({ problem: "package.json exports nothing" }),
    ])
  })

  it("passes a library made from the template", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "novadeck-library-"))
    onTestFinished(() => rmSync(workspace, { recursive: true, force: true }))
    cpSync(join(root, "tsconfig.base.json"), join(workspace, "tsconfig.base.json"))
    const folder = join(workspace, "libraries", "example")
    for (const [path, content] of Object.entries(template("example", "An example.", versions))) {
      mkdirSync(dirname(join(folder, path)), { recursive: true })
      writeFileSync(join(folder, path), content)
    }
    expect(await checkLibrary(folder)).toEqual([])
  })

  it("passes every library in libraries/", async () => {
    const found = libraries(join(root, "libraries"))
    expect((await Promise.all(found.map(checkLibrary))).flat()).toEqual([])
  })
})
