import { describe, expect, it } from "../test.js"
import { safeOf } from "./standing.js"

type Pull = { readonly state: "draft" | "open" | "merged" | "closed" }
const standing = (
  merged: boolean,
  uncommitted: number | undefined,
  unpushed: number | undefined,
  pullRequest?: Pull,
) => safeOf({ merged, uncommitted, unpushed, pullRequest })

describe("whether a work is safe to close", () => {
  it("is when it is merged with nothing uncommitted, whatever is unpushed", () => {
    expect(standing(true, 0, 3)).toBe(true)
    expect(standing(true, 0, 0, { state: "merged" })).toBe(true)
  })

  it("is not when a merged work holds uncommitted files", () => {
    expect(standing(true, 2, 0)).toBe(false)
  })

  it("is when its pull request was closed with nothing uncommitted or unpushed", () => {
    expect(standing(false, 0, 0, { state: "closed" })).toBe(true)
    expect(standing(false, 0, 1, { state: "closed" })).toBe(false)
    expect(standing(false, 1, 0, { state: "closed" })).toBe(false)
  })

  it("is never while its pull request is open or a draft", () => {
    expect(standing(true, 0, 0, { state: "open" })).toBe(false)
    expect(standing(true, 0, 0, { state: "draft" })).toBe(false)
    expect(standing(false, 0, 0, { state: "open" })).toBe(false)
  })

  it("is not for work that is neither merged nor closed", () => {
    expect(standing(false, 0, 0)).toBe(false)
    expect(standing(false, 0, 0, { state: "merged" })).toBe(false)
  })

  it("is unknown where what it needs could not be read", () => {
    expect(standing(true, undefined, 0)).toBeUndefined()
    expect(standing(false, 0, undefined, { state: "closed" })).toBeUndefined()
    // Merged ignores unpushed, so it is known without it.
    expect(standing(true, 0, undefined)).toBe(true)
  })
})
