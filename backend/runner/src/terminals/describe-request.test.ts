import { describe, expect, it } from "vitest"

import { readDescribeRequest, waitingForOf } from "./describe-request.js"

describe("what a description says its work waits on", () => {
  it("is read beside the title and summary, and left alone where absent", () => {
    expect(
      readDescribeRequest({ title: "T", summary: "S", waitingFor: "the review" }),
    ).toMatchObject({ ok: true, request: { waitingFor: "the review" } })
    expect(readDescribeRequest({ title: "T", summary: "S" })).toMatchObject({ ok: true })
    expect(waitingForOf(undefined, 5)).toBeUndefined()
  })

  it("is kept as one short line with when it was said, and cleared by empty words", () => {
    expect(waitingForOf("  the macOS\nrunner\u0007 ", 5)).toEqual({
      text: "the macOS runner",
      at: 5,
    })
    expect(waitingForOf("x".repeat(500), 5)?.text).toHaveLength(200)
    expect(waitingForOf(" \n ", 5)).toBeNull()
  })

  it("names the fields a description takes", () => {
    expect(readDescribeRequest({ title: "T", summary: "S", other: 1 })).toEqual({
      ok: false,
      reason:
        "A description takes only `title`, `summary`, `waitingFor`, `worktree` and `worktreeTitle`.",
    })
  })

  it("takes a worktree and its title only together", () => {
    const together =
      "`worktree` and `worktreeTitle` go together: the folder of a worktree you own, and its title."
    expect(readDescribeRequest({ title: "T", summary: "S", worktree: "/w" })).toEqual({
      ok: false,
      reason: together,
    })
    expect(readDescribeRequest({ title: "T", summary: "S", worktreeTitle: "W" })).toEqual({
      ok: false,
      reason: together,
    })
    // A blank pair, as some models fill every optional field, is none.
    expect(
      readDescribeRequest({ title: "T", summary: "S", worktree: "", worktreeTitle: "" }),
    ).toEqual({ ok: true, request: { title: "T", summary: "S" } })
    expect(
      readDescribeRequest({ title: "T", summary: "S", worktree: "/w", worktreeTitle: "W" }),
    ).toEqual({
      ok: true,
      request: { title: "T", summary: "S", worktree: "/w", worktreeTitle: "W" },
    })
  })
})
