import { paletteColour } from "@novadeck/core/conversation/slice"

import { describe, expect, it } from "../test"
import { requiredTokens } from "../theme/tokens"

// The chat's live slice draws a terminal's sixteen colours with the theme's: each must be a
// token every theme defines, for each scheme it offers.
describe("the live slice's colours", () => {
  it("are tokens every theme defines", () => {
    for (let index = 0; index < 16; index += 1) {
      const token = /^var\((--[a-z-]+)\)$/.exec(paletteColour(index))?.[1]
      expect(requiredTokens).toContain(token)
    }
  })
})
