import { readdirSync, readFileSync } from "node:fs"
import { join, posix } from "node:path"

import { describe, expect, it } from "./test"

// The core is a leaf: the model every other frontend package builds on, so it reaches no
// framework and no other package but the protocol's data-only entries below. Its files import
// one another by relative path, and are all `.ts`, which the `./*` export maps to; the other
// packages reach them as `@novadeck/core/<file>`.

// The files in the core that read the protocol, each through one data-only entry: its table of
// harnesses, the key that tells pages apart, what draws as nothing in a command, and the icons
// a release's highlight may name. An entry is added here when the core needs one; never the
// wire, or the runner client, which is a package of its own.
const protocolData: Record<string, string> = {
  "harnesses.ts": "@novadeck/protocol/harnesses",
  "pages.ts": "@novadeck/protocol/pages",
  "command-text.ts": "@novadeck/protocol/text",
  "update.ts": "@novadeck/protocol/release-notes",
}

// The entries above that are schemas, not data, and so are read for their types alone: a value
// from one would bring zod into the core and every page.
const typesOnly = new Set(["@novadeck/protocol/release-notes"])

const src = import.meta.dirname
const all = readdirSync(src, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) =>
    posix.relative(
      src.split("\\").join("/"),
      join(entry.parentPath, entry.name).split("\\").join("/"),
    ),
  )
const files = all.filter((file) => /\.tsx?$/.test(file))
const source = (file: string): string => readFileSync(join(src, file), "utf8")
const importPattern =
  /(?:^(?:import|export)(\s+type)?\b[^"']*?\bfrom|^import|\bimport\()\s*(["'])([^"']+)\2/gm
const imports = (file: string): string[] =>
  [...source(file).matchAll(importPattern)].map((match) => match[3]!)
// The specifiers a file reads for more than types: anything but `import type` and `export type`.
const valueImports = (file: string): string[] =>
  [...source(file).matchAll(importPattern)]
    .filter((match) => match[1] === undefined)
    .map((match) => match[3]!)
const isTest = (file: string): boolean => file.endsWith(".test.ts")
// The Vitest re-export is every package's own, and the only file that names vitest.
const sources = files.filter((file) => !isTest(file) && file !== "test.ts")

describe("core architecture", () => {
  it("reads the source of every folder", () => {
    expect(files).toEqual(expect.arrayContaining(["store.ts", "port.ts", "testing.ts"]))
  })

  it("holds only .ts files, which the ./* export maps to", () => {
    expect(all.filter((file) => !file.endsWith(".ts"))).toEqual([])
  })

  it("keeps its files to the core and the protocol's listed data entries", () => {
    const dataEntries = new Set(Object.values(protocolData))
    const found = sources.flatMap((file) =>
      imports(file).flatMap((specifier) => {
        if (dataEntries.has(specifier)) return []
        // Only another .ts file of the core, with no query that makes it a worker or text.
        if (specifier.startsWith(".")) {
          const target = posix.normalize(posix.join(posix.dirname(file), specifier))
          return !specifier.includes("?") &&
            !target.startsWith("..") &&
            all.includes(`${target}.ts`)
            ? []
            : [`${file} -> ${specifier}`]
        }
        return [`${file} -> ${specifier}`]
      }),
    )
    expect(found).toEqual([])
  })

  it("reads each protocol entry only in the file that lists it", () => {
    const found = sources.flatMap((file) =>
      imports(file)
        .filter((specifier) => Object.values(protocolData).includes(specifier))
        .filter((specifier) => protocolData[file] !== specifier)
        .map((specifier) => `${file} -> ${specifier}`),
    )
    expect(found).toEqual([])
  })

  it("reads a schema entry for its types alone", () => {
    const found = sources.flatMap((file) =>
      valueImports(file)
        .filter((specifier) => typesOnly.has(specifier))
        .map((specifier) => `${file} -> ${specifier}`),
    )
    expect(found).toEqual([])
  })

  it("keeps its tests inside the core, whatever they import besides", () => {
    const found = files.filter(isTest).flatMap((file) =>
      imports(file)
        .filter((specifier) => specifier.startsWith("."))
        .filter((specifier) =>
          posix.normalize(posix.join(posix.dirname(file), specifier)).startsWith(".."),
        )
        .map((specifier) => `${file} -> ${specifier}`),
    )
    expect(found).toEqual([])
  })

  it("has no data entry that no file reads", () => {
    const dead = Object.entries(protocolData)
      .filter(([file, entry]) => !files.includes(file) || !imports(file).includes(entry))
      .map(([file]) => file)
    expect(dead).toEqual([])
  })
})
