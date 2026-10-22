import { describe, expect, it } from "vitest"

import {
  parseWhatsNew,
  whatsNewHighlights,
  whatsNewLineLength,
  whatsNewTitleLength,
} from "../../contract/protocol/src/bridge.ts"

const highlight = (n: number) => ({ title: `Title ${n}`, line: `Line ${n}.` })

describe("parseWhatsNew", () => {
  it("keeps a version and its highlights as plain lines", () => {
    expect(parseWhatsNew({ version: "0.5.0", highlights: [highlight(1)] })).toEqual({
      version: "0.5.0",
      highlights: [highlight(1)],
    })
  })

  it("drops fields it does not know, such as the pull requests", () => {
    expect(
      parseWhatsNew({ version: "0.5.0", highlights: [{ ...highlight(1), prs: [3] }], extra: 1 }),
    ).toEqual({ version: "0.5.0", highlights: [highlight(1)] })
  })

  it("keeps the version it is new since, and leaves out one that is no version or the same", () => {
    expect(parseWhatsNew({ version: "0.5.0", from: "0.4.2", highlights: [highlight(1)] })).toEqual({
      version: "0.5.0",
      from: "0.4.2",
      highlights: [highlight(1)],
    })
    for (const from of ["0.5.0", "latest", "", 42, null, "<b>0.4.2</b>"])
      expect(
        parseWhatsNew({ version: "0.5.0", from, highlights: [highlight(1)] }),
      ).not.toHaveProperty("from")
  })

  it("turns control, format and separator characters into spaces", () => {
    const parsed = parseWhatsNew({
      version: "0.5.0",
      highlights: [{ title: "Fast‮er\nGrid", line: "One two\u0000   three​." }],
    })
    expect(parsed?.highlights).toEqual([{ title: "Fast er Grid", line: "One two three ." }])
  })

  it("counts the bounds in code points", () => {
    const title = "😀".repeat(whatsNewTitleLength)
    const line = "😀".repeat(whatsNewLineLength)
    expect(parseWhatsNew({ version: "0.5.0", highlights: [{ title, line }] })?.highlights).toEqual([
      { title, line },
    ])
    expect(
      parseWhatsNew({
        version: "0.5.0",
        highlights: [
          { title: title + "😀", line },
          { title, line: line + "😀" },
        ],
      }),
    ).toBeUndefined()
  })

  it("leaves out invalid highlights before it caps the valid ones", () => {
    const invalid = [{ title: "", line: "x" }, { title: "x" }, null, "text", 3]
    const valid = Array.from({ length: whatsNewHighlights + 2 }, (_, n) => highlight(n))
    const parsed = parseWhatsNew({ version: "0.5.0", highlights: [...invalid, ...valid] })
    expect(parsed?.highlights).toEqual(valid.slice(0, whatsNewHighlights))
  })

  it("is nothing for a shape the contract does not allow", () => {
    for (const value of [
      undefined,
      null,
      "0.5.0",
      [],
      { highlights: [highlight(1)] },
      { version: "latest", highlights: [highlight(1)] },
      { version: "0.5.0" },
      { version: "0.5.0", highlights: "no" },
      { version: "0.5.0", highlights: [] },
      { version: "0.5.0", highlights: [{ title: "​", line: "x" }] },
    ])
      expect(parseWhatsNew(value)).toBeUndefined()
  })
})
