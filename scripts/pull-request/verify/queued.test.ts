import { describe, expect, it } from "../../test"
import { queuedEnv, queuedNumber } from "./queued"

const sha = "0123456789abcdef0123456789abcdef01234567"

describe("a merge group's pull request", () => {
  it.each([
    [`refs/heads/gh-readonly-queue/main/pr-849-${sha}`, "849"],
    [`gh-readonly-queue/main/pr-7-${sha}`, "7"],
    [`refs/heads/gh-readonly-queue/release/1.x/pr-12-${sha}`, "12"],
  ])("is read from the group's branch %s", (ref, number) => {
    expect(queuedNumber(ref)).toBe(number)
  })

  it.each([
    undefined,
    "",
    "refs/heads/main",
    `refs/heads/gh-readonly-queue/main/pr-x-${sha}`,
    "refs/heads/gh-readonly-queue/main/pr-849-0123",
    `refs/heads/task/gh-readonly-queue/main/pr-849-${sha}`,
  ])("is none for %s", (ref) => {
    expect(queuedNumber(ref)).toBeUndefined()
  })

  it("is read from the API, as a pull request's event would give it", () => {
    const asked: string[][] = []
    const env = queuedEnv(
      {
        GITHUB_REPOSITORY: "novadeck-org/novadeck",
        MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/main/pr-849-${sha}`,
      },
      (args) => {
        asked.push(args)
        return JSON.stringify({ title: "ci: a title", body: null, author: "m", commits: 3 })
      },
    )
    expect(asked[0]?.slice(0, 2)).toEqual(["api", "repos/novadeck-org/novadeck/pulls/849"])
    expect(env).toMatchObject({
      PR_NUMBER: "849",
      PR_TITLE: "ci: a title",
      PR_BODY: "",
      PR_AUTHOR: "m",
      PR_COMMITS: "3",
    })
  })

  // A group Verify can't check fails it, and the queue ejects the pull request.
  it("fails where the branch names none", () => {
    expect(() =>
      queuedEnv(
        { GITHUB_REPOSITORY: "novadeck-org/novadeck", MERGE_GROUP_HEAD_REF: "main" },
        () => {
          throw new Error("never asked")
        },
      ),
    ).toThrow("names no pull request")
  })
})
