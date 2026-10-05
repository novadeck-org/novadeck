import { context, describe, expect, it } from "../test"
import { dataFolderName } from "./data-folder"

describe("data folder name", () => {
  context("in a packaged app", () => {
    it("is NovaDeck", () => {
      expect(dataFolderName({ packaged: true })).toBe("NovaDeck")
    })
  })

  context("in development", () => {
    it("is a folder of its own, apart from an installed app's", () => {
      expect(dataFolderName({ packaged: false })).toBe("NovaDeck-dev")
    })
  })
})
