import { matchesGlob } from "node:path"

import { describe, expect, it } from "vitest"

import { unit } from "./vitest.ts"

describe("unit", () => {
  const runs = (file: string): boolean =>
    (unit().test?.include ?? []).some((pattern) => matchesGlob(file, pattern))

  it("runs a package's tests, written as .ts or as .tsx", () => {
    expect(runs("src/queries.test.ts")).toBe(true)
    expect(runs("src/peek/Peek.test.tsx")).toBe(true)
  })

  it("runs nothing that is not a test, or outside src", () => {
    expect(runs("src/peek/Peek.tsx")).toBe(false)
    expect(runs("e2e/peek.test.ts")).toBe(false)
  })
})
