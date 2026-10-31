import { describe, expect, it } from "vitest"

import { judgeJob, parseRegister } from "./match.ts"

// The specs moved into their own package, so Vitest reports `src/x.spec.tsx` where it reported
// `src/specs/x.spec.tsx`: a flake registered by either form is known in a log of either.
const register = parseRegister({
  aggregates: [],
  flakes: [
    {
      id: "moved",
      jobs: ["^Test \\(Linux\\)$"],
      test: "src/companions.spec.tsx > Switching views > opens a plan",
      signature: "AssertionError",
      status: "known",
      cause: "Unknown.",
      seen: ["#1"],
    },
    {
      id: "old",
      jobs: ["^Test \\(Linux\\)$"],
      test: "src/specs/agents.spec.tsx > A pinned project > reorders",
      signature: "AssertionError",
      status: "known",
      cause: "Unknown.",
      seen: ["#2"],
    },
  ],
})

const log = (file: string, test: string): string =>
  [` FAIL  behaviour (chromium)  ${file} > ${test}`, "AssertionError: expected 1 to be 2"].join(
    "\n",
  )

describe("a flake registered before the specs had a package", () => {
  it("is known by the id the specs' package reports, and by the older one", () => {
    for (const [file, id] of [
      ["src/companions.spec.tsx", "moved"],
      ["src/specs/companions.spec.tsx", "moved"],
      ["src/agents.spec.tsx", "old"],
      ["src/specs/agents.spec.tsx", "old"],
    ] as const) {
      const test = id === "moved" ? "Switching views > opens a plan" : "A pinned project > reorders"
      expect(judgeJob(register, "Test (Linux)", log(file, test))).toMatchObject({ flakes: [id] })
    }
  })

  it("leaves another spec's failure to be triaged", () => {
    const verdict = judgeJob(
      register,
      "Test (Linux)",
      log("src/other.spec.tsx", "Switching views > opens a plan"),
    )
    expect(verdict).toMatchObject({ flakes: [] })
  })
})

describe("a flake registered before the specs went into domain folders", () => {
  const moved = parseRegister({
    aggregates: [],
    flakes: [
      {
        id: "pins",
        jobs: ["^Test \\(Linux\\)$"],
        test: "src/projects/pins.spec.tsx > A pinned project > reorders",
        signature: "AssertionError",
        status: "known",
        cause: "Unknown.",
        seen: ["#3"],
      },
      {
        id: "grid",
        jobs: ["^Test \\(Linux\\)$"],
        test: "src/grid.spec.tsx > Grid view > keeps its layout",
        signature: "AssertionError",
        status: "known",
        cause: "Unknown.",
        seen: ["#4"],
      },
    ],
  })

  it("is known by its file's new folder, and by the names it had before", () => {
    for (const [file, test, id] of [
      ["src/projects/pins.spec.tsx", "A pinned project > reorders", "pins"],
      ["src/agents.spec.tsx", "A pinned project > reorders", "pins"],
      ["src/specs/agents.spec.tsx", "A pinned project > reorders", "pins"],
      ["src/views/grid.spec.tsx", "Grid view > keeps its layout", "grid"],
      ["src/grid.spec.tsx", "Grid view > keeps its layout", "grid"],
    ] as const)
      expect(judgeJob(moved, "Test (Linux)", log(file, test)), file).toMatchObject({
        flakes: [id],
      })
  })

  it("leaves a group that stayed behind in the old file to be triaged", () => {
    const verdict = judgeJob(
      moved,
      "Test (Linux)",
      log("src/agents.spec.tsx", "A pinned projectile > reorders"),
    )
    expect(verdict).toMatchObject({ flakes: [] })
  })
})
