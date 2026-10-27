import { describe, expect, it } from "vitest"

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
        sources({ tags: ["v0.0.260", "v0.0.261"], sinceNewest: "minor", sinceStable: "minor" }),
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
          sources({ tags: ["v1.0.0"], stable: "v1.0.0", sinceNewest: level, sinceStable: level }),
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
          tags: ["v1.0.0", "v9.0.0-beta.1", "nightly"],
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
    const after = sources({ tags: ["v1.0.0", "v1.1.0"], stable: "v1.0.0", sinceNewest: "patch" })
    await expect(planVersion("1.1.0", after)).rejects.toThrow("not newer than")
    await expect(planVersion("1.0.5", after)).rejects.toThrow("not newer than")
    await expect(planVersion("1.2", after)).rejects.toThrow("not a version")
    await expect(planVersion("1.2.0-rc.1", after)).rejects.toThrow("not a version")
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
