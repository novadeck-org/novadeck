import { describe, expect, it } from "vitest"

import { demoOutputPath, demoShellOutput, printEveryMs } from "./shell-output"

const running = (command: string, since: number) => ({
  command,
  since,
  exit: null,
  output: demoOutputPath("ready"),
})

describe("demoShellOutput", () => {
  it("has a running shell print on, a line every few seconds, numbered on from its last", () => {
    const first = demoShellOutput(running("pnpm dev --filter storefront", 0), 0)
    const later = demoShellOutput(running("pnpm dev --filter storefront", 0), 5 * printEveryMs)
    if (first.state !== "ready" || later.state !== "ready") throw new Error("not ready")
    expect(later.total).toBe(first.total + 5)
  })

  it("says what a command run in a terminal of the agent's own, or a cleared one, has", () => {
    expect(demoShellOutput({ ...running("x", 0), output: demoOutputPath("none") }, 1)).toEqual({
      state: "none",
    })
    expect(demoShellOutput({ ...running("x", 0), output: demoOutputPath("gone") }, 1)).toEqual({
      state: "gone",
    })
  })

  it("keeps an ended shell's output as it ended", () => {
    const ended = {
      ...running("docker compose up postgres", 0),
      exit: { at: 5, code: 1 },
    }
    expect(demoShellOutput(ended, 10)).toEqual(demoShellOutput(ended, 100_000))
  })
})
