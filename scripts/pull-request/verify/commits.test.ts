import { describe, expect, it } from "../../test"
import { attributionErrors } from "./attribution"
import { commitSources, parseCommits, pullRequestCommits } from "./commits"

const commit = (sha: string, message: string, name: string, email: string, login: string) =>
  JSON.stringify({ sha, message, name, email, login })

const env = {
  GITHUB_REPOSITORY: "novadeck-org/novadeck",
  PR_NUMBER: "7",
  PR_COMMITS: "2",
}

const human = commit(
  "a".repeat(40),
  "fix: x\r\n\r\nSigned-off-by: M <m@x.dev>",
  "M",
  "m@x.dev",
  "m",
)
const dependabot = commit(
  "b".repeat(40),
  "build(deps): bump x\n\nCo-authored-by: dependabot[bot] <1+dependabot[bot]@users.noreply.github.com>",
  "dependabot[bot]",
  "1+dependabot[bot]@users.noreply.github.com",
  "dependabot[bot]",
)

describe("pull request commits", () => {
  it.each([
    ["Copilot", "copilot-swe-agent[bot]", "198982749+Copilot@users.noreply.github.com", "Copilot"],
    [
      "Jules",
      "google-labs-jules[bot]",
      "161369871+google-labs-jules[bot]@users.noreply.github.com",
      "google-labs-jules[bot]",
    ],
    ["Claude", "claude[bot]", "209825114+claude[bot]@users.noreply.github.com", "claude[bot]"],
    ["Codex", "codex", "codex@openai.com", "codex"],
    ["Antigravity", "Antigravity", "noreply@google.com", "antigravity"],
  ])("flags a %s commit author", (_tool, name, email, login) => {
    const errors = attributionErrors(
      commitSources(parseCommits(commit("c".repeat(40), "fix: x", name, email, login))),
    )
    expect(errors[0]).toMatch(/^Commit ccccccc's author has AI attribution/)
    expect(errors[0]).toContain("open a new branch with the reworded commits")
  })

  it("passes human and dependabot commits", () => {
    expect(attributionErrors(commitSources(parseCommits(`${human}\n${dependabot}`)))).toEqual([])
  })

  it("passes a commit whose author has no GitHub login", () => {
    expect(
      attributionErrors(
        commitSources(
          parseCommits(commit("d".repeat(40), "fix: x", "M", "m@x.dev", null as never)),
        ),
      ),
    ).toEqual([])
  })

  it("fetches and checks every commit", () => {
    const sources = pullRequestCommits(env, () => `${human}\n${dependabot}\n`)
    expect(sources).toHaveLength(4)
  })

  it("fails when the fetched count still differs after one retry", () => {
    let calls = 0
    const fetch = () => (calls++, human)
    expect(() => pullRequestCommits(env, fetch, () => {})).toThrow(/Fetched 1 commits but .* has 2/)
    expect(calls).toBe(2)
  })

  it("retries once when the endpoint lags the payload", () => {
    let calls = 0
    const waits: number[] = []
    const fetch = () => (calls++ === 0 ? human : `${human}\n${dependabot}`)
    expect(pullRequestCommits(env, fetch, (ms) => waits.push(ms))).toHaveLength(4)
    expect(waits).toEqual([5000])
  })

  it("fails as required when PR_COMMITS is empty", () => {
    expect(() =>
      pullRequestCommits(
        { ...env, PR_COMMITS: "" },
        () => "",
        () => {},
      ),
    ).toThrow(/PR_COMMITS is required/)
  })

  it("fails over the 250-commit cap", () => {
    expect(() => pullRequestCommits({ ...env, PR_COMMITS: "251" }, () => "")).toThrow(/at most 250/)
  })

  it("fails when PR_COMMITS is missing", () => {
    expect(() => pullRequestCommits({ ...env, PR_COMMITS: undefined }, () => "")).toThrow(
      /PR_COMMITS/,
    )
  })

  it("throws in Actions without the pull request env", () => {
    expect(() => pullRequestCommits({ GITHUB_ACTIONS: "true" }, () => "")).toThrow(/PR_NUMBER/)
  })

  it("skips locally without the pull request env", () => {
    expect(pullRequestCommits({}, () => "")).toEqual([])
  })
})
