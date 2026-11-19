import { describe, expect, it } from "vitest"

import { isDataPath } from "../../contract/protocol/src/companions.ts"
import { dataFormatOf } from "../../libraries/viewers/src/tree/format.ts"

// The runner reads a data file whole (the protocol's `isDataPath`) for its preview to read it
// as a whole; a type the tree reads (`dataFormatOf`) that the runner didn't would come as
// 400 lines cut at 4,096 characters, and its records would break.
describe("the files read whole", () => {
  it("hold every type the data tree reads", () => {
    const names = [
      "a.json",
      "a.jsonl",
      "a.ndjson",
      "a.yaml",
      "a.yml",
      "a.jsonc",
      "a.toml",
      "a.json5",
    ]
    const unread = names.filter((name) => dataFormatOf(name) !== undefined && !isDataPath(name))
    expect(unread).toEqual([])
  })
})
