import { describe, expect, it } from "vitest"
import type { z } from "zod"

import { companionItem, itemContent, pageLook, pageLookAnswer } from "./companions.js"

const lookId = "11111111-1111-4111-8111-111111111111"
const itemId = "22222222-2222-4222-8222-222222222222"
// A dev server's callback, its query holding a token, as long as a page item's address runs.
const longAddress = `http://localhost:3000/callback?state=${"x".repeat(3000)}`

const maxOf = (schema: z.ZodString): number => schema.maxLength!

// A value one schema carries into another must fit the second wherever it fits the first, or
// the runner's check of what it sends fails the call or ends the stream it goes out on.
describe("an address carried from a page item", () => {
  const itemUrl = maxOf(companionItem.shape.url.unwrap())

  it("fits the page's content", () => {
    const page = itemContent.options[0].shape.content.options[2]
    expect(maxOf(page.shape.url)).toBeGreaterThanOrEqual(itemUrl)
  })

  it("fits a look at the page", () => {
    expect(maxOf(pageLook.shape.url)).toBeGreaterThanOrEqual(itemUrl)
  })

  it("fits the look's answer, which says where the page is", () => {
    expect(maxOf(pageLookAnswer.options[0].shape.url)).toBeGreaterThanOrEqual(itemUrl)
  })
})

describe("a look at a page with a long address", () => {
  it("goes out to the client", () => {
    expect(pageLook.parse({ lookId, itemId, shown: 1, url: longAddress }).url).toBe(longAddress)
  })

  it("comes back answered", () => {
    const answer = {
      lookId,
      picture: "data:image/jpeg;base64,AAAA",
      url: longAddress,
      title: "Callback",
      taken: "pane" as const,
      size: { width: 1280, height: 800 },
      troubles: [],
    }
    expect(pageLookAnswer.parse(answer)).toEqual(answer)
  })
})
