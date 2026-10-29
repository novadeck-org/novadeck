import { execFileSync } from "node:child_process"

import { afterAll, describe, expect, it } from "vitest"

import { history, removeHistories, type Step } from "../release-notes/history.ts"
import { makeGitSources, newestRelease, refOf } from "../release-notes/sources.ts"
import { main, planVersion, type Sources } from "./main.ts"

type Level = "major" | "minor" | "patch" | undefined

const raise = (version: string, level: Exclude<Level, undefined>): string => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number)
  return level === "major"
    ? `${major + 1}.0.0`
    : level === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`
}

/**
 * Sources whose tags end at `newest`, and whose commits since it and since the stable release
 * call for `sinceNewest` and `sinceStable`, raising the newest tag as release-it does.
 */
const sources = (options: {
  readonly tags: readonly string[]
  readonly stable?: string
  readonly sinceNewest: Level
  readonly sinceStable?: Level
}): Sources => {
  const newest = options.tags.at(-1)?.slice(1) ?? "0.0.0"
  return {
    tags: async () => [...options.tags],
    anyRelease: async () => options.tags.length > 0,
    stable: async () => options.stable,
    recommend: async (from) => {
      const level = from === undefined ? options.sinceNewest : options.sinceStable
      return level && raise(newest, level)
    },
  }
}

describe("planVersion", () => {
  it("releases nothing when no commit since the newest release publishes one", async () => {
    expect(
      await planVersion(
        undefined,
        sources({ tags: ["v1.0.0"], stable: "v1.0.0", sinceNewest: undefined }),
      ),
    ).toBeUndefined()
  })

  it("takes the next patch before the first stable release, even for a feature", async () => {
    expect(
      await planVersion(
        undefined,
        sources({
          tags: ["v0.0.260", "v0.0.261"],
          sinceNewest: "minor",
          sinceStable: "minor",
        }),
      ),
    ).toBe("0.0.262")
  })

  it.each([
    ["patch", "1.0.1"],
    ["minor", "1.1.0"],
    ["major", "2.0.0"],
  ] as const)(
    "starts a cycle at the level the commits since the stable release call for (%s)",
    async (level, version) => {
      expect(
        await planVersion(
          undefined,
          sources({
            tags: ["v1.0.0"],
            stable: "v1.0.0",
            sinceNewest: level,
            sinceStable: level,
          }),
        ),
      ).toBe(version)
    },
  )

  it("takes the next patch within a cycle", async () => {
    expect(
      await planVersion(
        undefined,
        sources({
          tags: ["v1.0.0", "v1.1.0", "v1.1.1"],
          stable: "v1.0.0",
          sinceNewest: "patch",
          sinceStable: "minor",
        }),
      ),
    ).toBe("1.1.2")
    // A feature in a cycle that is already a minor one moves nothing up.
    expect(
      await planVersion(
        undefined,
        sources({
          tags: ["v1.0.0", "v1.1.0"],
          stable: "v1.0.0",
          sinceNewest: "minor",
          sinceStable: "minor",
        }),
      ),
    ).toBe("1.1.1")
  })

  it("moves the cycle up when a commit calls for more than it has", async () => {
    expect(
      await planVersion(
        undefined,
        sources({
          tags: ["v1.0.0", "v1.0.1", "v1.0.2"],
          stable: "v1.0.0",
          sinceNewest: "minor",
          sinceStable: "minor",
        }),
      ),
    ).toBe("1.1.0")
    expect(
      await planVersion(
        undefined,
        sources({
          tags: ["v1.0.0", "v1.1.0", "v1.1.3"],
          stable: "v1.0.0",
          sinceNewest: "major",
          sinceStable: "major",
        }),
      ),
    ).toBe("2.0.0")
  })

  it("counts from the promoted release, not the newest one", async () => {
    // 1.1.2 was promoted while 1.1.3 was out; a feature since then starts 1.2.0.
    expect(
      await planVersion(
        undefined,
        sources({
          tags: ["v1.1.0", "v1.1.2", "v1.1.3"],
          stable: "v1.1.2",
          sinceNewest: "minor",
          sinceStable: "minor",
        }),
      ),
    ).toBe("1.2.0")
    expect(
      await planVersion(
        undefined,
        sources({
          tags: ["v1.1.0", "v1.1.2", "v1.1.3"],
          stable: "v1.1.2",
          sinceNewest: "patch",
          sinceStable: "patch",
        }),
      ),
    ).toBe("1.1.4")
  })

  it("ignores tags that are not plain versions", async () => {
    expect(
      await planVersion(
        undefined,
        sources({
          // The fake raises the last tag; a 9.0.0 taken for the newest would plan 9.0.1.
          tags: ["v9.0.0-beta.1", "nightly", "v1.0.0"],
          stable: "v1.0.0",
          sinceNewest: "patch",
          sinceStable: "patch",
        }),
      ),
    ).toBe("1.0.1")
  })

  it("releases as a requested version newer than every release", async () => {
    const before = sources({ tags: ["v0.0.261"], sinceNewest: undefined })
    expect(await planVersion("1.0.0", before)).toBe("1.0.0")
    expect(await planVersion("v1.0.0", before)).toBe("1.0.0")
  })

  it("refuses a requested version that is not newer or not a version", async () => {
    const after = sources({
      tags: ["v1.0.0", "v1.1.0"],
      stable: "v1.0.0",
      sinceNewest: "patch",
    })
    await expect(planVersion("1.1.0", after)).rejects.toThrow("not newer than")
    await expect(planVersion("1.0.5", after)).rejects.toThrow("not newer than")
    await expect(planVersion("1.2", after)).rejects.toThrow("not a version")
    await expect(planVersion("1.2.0-rc.1", after)).rejects.toThrow("not a version")
  })
})

// The first two commits are older than the rewrite's first change: they stay, with v0.0.1.
const steps: Step[] = [
  ["chore: init (#1)"],
  ["feat: first (#2)", "v0.0.1"],
  ["fix: second (#3)"],
  ["feat: third (#4)", "v1.1.0"],
  ["fix: fourth (#5)"],
  ["fix: fifth (#6)", "v1.1.1"],
  ["chore: sixth (#7)"],
]

afterAll(removeHistories)

/**
 * Real git over `cwd`, with release-it's step stood in for by what the subjects call for: the
 * newest tag on main raised by the commits since `from`, as the command does (see main.ts).
 */
const gitPlan = (cwd: string, stable: string | undefined, releases = true): Sources => {
  const git = makeGitSources(cwd)
  return {
    tags: () => git.tags("HEAD"),
    anyRelease: async () => releases,
    stable: async () => stable,
    recommend: async (from) => {
      const tags = (await git.tags("HEAD")).toSorted((a, b) =>
        a.localeCompare(b, "en", { numeric: true }),
      )
      const base = from ? await refOf(from, cwd) : await refOf(tags.at(-1)!, cwd)
      const subjects = execFileSync("git", ["log", "--format=%s", `${base}..HEAD`], {
        cwd,
        encoding: "utf8",
      })
      const level = /^feat/m.test(subjects) ? "minor" : /^fix/m.test(subjects) ? "patch" : undefined
      return level && raise(tags.at(-1)!.slice(1), level)
    },
  }
}

describe("planVersion over rewritten history", () => {
  const made = (subject: string, marked: string[]) => {
    const built = history(steps, 2)
    built.mark(...marked)
    built.after([subject])
    return built
  }

  it.each([
    ["fix: seventh (#8)", "1.1.2"],
    ["feat: seventh (#8)", "1.2.0"],
    ["chore: seventh (#8)", undefined],
  ] as const)("plans what the original history planned for %s", async (subject, version) => {
    const { original, rewritten } = made(subject, ["v1.1.0", "v1.1.1"])
    expect(await planVersion(undefined, gitPlan(original, "v1.1.0"))).toBe(version)
    expect(await planVersion(undefined, gitPlan(rewritten, "v1.1.0"))).toBe(version)
  })

  it("plans as before once a release of its own follows the markers", async () => {
    const built = history(steps, 2)
    built.mark("v1.1.0", "v1.1.1")
    built.after(["fix: seventh (#8)", "v1.1.2"], ["fix: eighth (#9)"])
    expect(await planVersion(undefined, gitPlan(built.rewritten, "v1.1.0"))).toBe("1.1.3")
    expect(await planVersion(undefined, gitPlan(built.original, "v1.1.0"))).toBe("1.1.3")
  })

  it("plans the same on today's history, which has no markers", async () => {
    const built = history(steps, steps.length)
    built.after(["fix: seventh (#8)"])
    expect(await planVersion(undefined, gitPlan(built.original, "v1.1.0"))).toBe("1.1.2")
  })

  it("reads the newest release across tags that stayed and markers, release-it's base included", async () => {
    const built = made("fix: seventh (#8)", ["v1.1.0", "v1.1.1"])
    // v0.0.1 is still reachable but older than the marker: the marker is the one to read.
    expect(await newestRelease(built.rewritten)).toEqual({
      tag: "v1.1.1",
      ref: "release-base/v1.1.1",
    })
    expect(await newestRelease(built.original)).toEqual({ tag: "v1.1.1", ref: "v1.1.1" })
    expect(await newestRelease(history([["chore: init (#1)"]]).original)).toBeUndefined()
  })

  it("fails loudly when releases exist but no tag or marker is on main", async () => {
    const built = history(steps)
    built.after(["fix: seventh (#8)"])
    const message = "no vX.Y.Z tag or release-base/vX.Y.Z marker"
    await expect(planVersion(undefined, gitPlan(built.rewritten, "v1.1.0"))).rejects.toThrow(
      message,
    )
    // A requested version does not get past it either.
    await expect(planVersion("2.0.0", gitPlan(built.rewritten, undefined))).rejects.toThrow(message)
  })

  it("fails loudly when the stable release has no marker, though an older tag stayed", async () => {
    const built = made("fix: seventh (#8)", ["v1.1.1"])
    await expect(planVersion(undefined, gitPlan(built.rewritten, "v1.1.0"))).rejects.toThrow(
      "v1.1.0 is not an ancestor of HEAD, and has no release-base/v1.1.0 marker",
    )
  })

  it("refuses a requested version too when the stable release is out of reach", async () => {
    const built = made("fix: seventh (#8)", ["v1.1.1"])
    const stuck = gitPlan(built.rewritten, "v1.1.0")
    const message = "v1.1.0 is not an ancestor of HEAD, and has no release-base/v1.1.0 marker"
    await expect(planVersion("1.2.0", stuck)).rejects.toThrow(message)
    await expect(planVersion("1.0.5", stuck)).rejects.toThrow(message)
    expect(
      await planVersion(
        "1.2.0",
        gitPlan(made("fix: x (#8)", ["v1.1.0", "v1.1.1"]).rewritten, "v1.1.0"),
      ),
    ).toBe("1.2.0")
  })

  it("asks GitHub for the stable release once per plan", async () => {
    const built = made("fix: seventh (#8)", ["v1.1.0", "v1.1.1"])
    const calls: string[] = []
    const watched: Sources = {
      ...gitPlan(built.rewritten, "v1.1.0"),
      anyRelease: async () => (calls.push("anyRelease"), true),
      stable: async () => (calls.push("stable"), "v1.1.0"),
    }
    await planVersion(undefined, watched)
    expect(calls).toEqual(["stable"])
  })

  it("plans a first release when GitHub has none", async () => {
    const built = history([["feat: first (#1)"]])
    const none = { ...gitPlan(built.original, undefined, false), recommend: async () => "0.1.0" }
    expect(await planVersion(undefined, none)).toBe("0.1.0")
  })
})

describe("main", () => {
  const plan = sources({
    tags: ["v1.0.0"],
    stable: "v1.0.0",
    sinceNewest: "minor",
    sinceStable: "minor",
  })

  it("prints the version, or nothing when there is nothing to release", async () => {
    const printed: string[] = []
    await main([], plan, (line) => printed.push(line))
    await main([""], plan, (line) => printed.push(line))
    await main(["2.0.0"], plan, (line) => printed.push(line))
    await main([], sources({ tags: ["v1.0.0"], sinceNewest: undefined }), (line) =>
      printed.push(line),
    )
    expect(printed).toEqual(["1.1.0", "1.1.0", "2.0.0"])
  })

  it("refuses more than one argument", async () => {
    await expect(main(["1.0.0", "2.0.0"], plan)).rejects.toThrow("Usage")
  })
})
