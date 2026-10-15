import { withSearchVisibility } from "./search-visibility"
import { context, describe, expect, it } from "./test"

const html = "<html><head><title>x</title></head><body></body></html>"

describe("search visibility", () => {
  context("for the visitor build", () => {
    it("asks search engines not to index the page", () => {
      expect(withSearchVisibility(html, "try")).toContain(
        '<meta name="robots" content="noindex" />',
      )
    })
  })

  context("for any other build", () => {
    it("leaves the page as it is", () => {
      expect(withSearchVisibility(html, "production")).toBe(html)
    })
  })
})
