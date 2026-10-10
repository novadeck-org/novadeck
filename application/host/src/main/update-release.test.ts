import { describe, expect, it } from "../test"
import { releaseDownloadsUrl, releasePageUrl, releaseRepositoryOf } from "./update-release"

const yaml = (owner: string, repo: string, provider = "github"): string =>
  `provider: ${provider}\nowner: ${owner}\nrepo: ${repo}\nreleaseType: prerelease\nupdaterCacheDirName: novadeck-updater\n`

describe("the repository a build updates from", () => {
  it("is read from the app-update.yml electron-builder writes", () => {
    expect(releaseRepositoryOf(yaml("novadeck-org", "novadeck"))).toEqual({
      owner: "novadeck-org",
      repo: "novadeck",
    })
  })

  it("accepts quoted values and Windows line endings", () => {
    expect(releaseRepositoryOf(yaml('"some-org"', "'my.repo_1'").replace(/\n/gu, "\r\n"))).toEqual({
      owner: "some-org",
      repo: "my.repo_1",
    })
  })

  it("is nothing for another provider or a file without one", () => {
    expect(releaseRepositoryOf(yaml("o", "r", "generic"))).toBeUndefined()
    expect(releaseRepositoryOf("owner: o\nrepo: r\n")).toBeUndefined()
  })

  it("is nothing without an owner or a repository", () => {
    expect(releaseRepositoryOf("provider: github\nrepo: r\n")).toBeUndefined()
    expect(releaseRepositoryOf("provider: github\nowner: o\n")).toBeUndefined()
    expect(releaseRepositoryOf("")).toBeUndefined()
  })

  it("is nothing for an owner or repository GitHub does not have", () => {
    for (const owner of ["-lead", "with space", "a/b", "../x", "x".repeat(40), "o?x=1", "o#", "@o"])
      expect(releaseRepositoryOf(yaml(owner, "novadeck"))).toBeUndefined()
    for (const repo of [".", "..", "a/b", "r r", "r?x", "r#", "r".repeat(101), "r\\x", "%2e"])
      expect(releaseRepositoryOf(yaml("novadeck-org", repo))).toBeUndefined()
  })

  it("ignores keys that are not at the top of the file", () => {
    expect(releaseRepositoryOf("provider: github\nother:\n  owner: o\n  repo: r\n")).toBeUndefined()
  })
})

describe("the page of a release", () => {
  const repository = { owner: "novadeck-org", repo: "novadeck" }

  it("is the release's tag page on GitHub", () => {
    expect(releasePageUrl(repository, "1.2.3")).toBe(
      "https://github.com/novadeck-org/novadeck/releases/tag/v1.2.3",
    )
    expect(releasePageUrl(repository, "0.10.0-rc.1")).toBe(
      "https://github.com/novadeck-org/novadeck/releases/tag/v0.10.0-rc.1",
    )
  })

  it("is nothing for a version that is not a release's", () => {
    for (const version of ["", "latest", "1.2", "1.2.3/../..", "1.2.3?x", "1.2.3 ", "v1.2.3"])
      expect(releasePageUrl(repository, version)).toBeUndefined()
  })
})

describe("the address a release's assets are downloaded from", () => {
  const repository = { owner: "novadeck-org", repo: "novadeck" }

  it("is the release's download folder on GitHub", () => {
    expect(releaseDownloadsUrl(repository, "1.2.3")).toBe(
      "https://github.com/novadeck-org/novadeck/releases/download/v1.2.3/",
    )
  })

  it("is nothing for a version that is not a release's", () => {
    expect(releaseDownloadsUrl(repository, "1.2.3/../x")).toBeUndefined()
  })
})
