import { readFileSync } from "node:fs"

import { describe, expect, it } from "./test"

// The frame page the PDF and 3D model viewers run in, which every app serves from this public
// folder beside its own page: the viewers library's own (libraries/viewers/src/frame/frame.html),
// byte for byte, as its policy names its script by its hash.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("the viewers' frame page", () => {
  it("is served as the viewers library writes it", () => {
    expect(read("../public/viewer-frame.html")).toBe(
      read("../../../libraries/viewers/src/frame/frame.html"),
    )
  })
})
