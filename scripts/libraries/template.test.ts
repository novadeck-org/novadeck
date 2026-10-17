import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { isLibraryName, template } from "./template.ts"

describe("a new library's name", () => {
  it("is lower-case words joined by hyphens", () => {
    expect(isLibraryName("tui-input", [])).toBe(true)
    expect(isLibraryName("TuiInput", [])).toBe(false)
    expect(isLibraryName("tui--input", [])).toBe(false)
    expect(isLibraryName("-tui", [])).toBe(false)
  })

  it("is no workspace package's, and never a harness's", () => {
    expect(isLibraryName("ui", ["ui", "runner"])).toBe(false)
    expect(isLibraryName("harness-kit", [])).toBe(false)
  })
})

describe("a new library's files", () => {
  const files = template("example", "An example.", {
    "@types/node": "1.0.0",
    typescript: "1.0.0",
    vitest: "1.0.0",
  })

  // The sandbox, the one library there is, was written before the template had these.
  it.each(["turbo.json", "tsconfig.json"])("%s is the sandbox's", (path) => {
    const sandbox = join(import.meta.dirname, "../../libraries/sandbox", path)
    expect(JSON.parse(files[path]!)).toEqual(JSON.parse(readFileSync(sandbox, "utf8")))
  })
})
