import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import type { ContractSnapshot } from "../../contract/protocol/src/snapshot.ts"
import { contractPath, gitSources, main, type Sources } from "./main.ts"

// The contract as this build has it, which the protocol's test keeps current.
const written = readFileSync(new URL(`../../${contractPath}`, import.meta.url), "utf8")
const contract = JSON.parse(written) as ContractSnapshot

// The contract without one procedure, under `window`.
const without = (path: string, window: Partial<ContractSnapshot> = {}): string => {
  const { [path]: _, ...procedures } = contract.procedures
  return JSON.stringify({ ...contract, ...window, procedures })
}

const sources = (released: string | undefined, current: string, newest = "v1.0.0"): Sources => ({
  newest: () => Promise.resolve(newest),
  released: () => Promise.resolve(released),
  current: () => Promise.resolve(current),
})

const check = async (args: readonly string[], given: Sources) => {
  const lines: string[] = []
  const code = await main(args, given, (line) => lines.push(line))
  return { code, out: lines.join("\n") }
}

describe("main", () => {
  it("passes the contract against itself", async () => {
    const { code, out } = await check([], sources(written, written))
    expect(code).toBe(0)
    expect(out).toContain("Contract compared with v1.0.0")
    expect(out).toContain("Passed.")
  })

  it("fails a change that leaves older UIs behind without moving oldestClient", async () => {
    const after = without("projects.rename", { revision: contract.revision + 1 })
    const { code, out } = await check([], sources(written, after))
    expect(code).toBe(1)
    expect(out).toContain("projects.rename: is gone, which an older UI may still call")
    expect(out).toContain("raise oldestClient")
  })

  it("passes it once oldestClient moved past the release's revision", async () => {
    const next = contract.revision + 1
    const after = without("projects.rename", { revision: next, oldestClient: next })
    const { code, out } = await check([], sources(written, after))
    expect(code).toBe(0)
    expect(out).toContain("Passed: each change moved its side's edge.")
  })

  it("compares with the ref it's given, as the release does with the previous tag", async () => {
    const asked: string[] = []
    const given: Sources = {
      ...sources(written, written),
      released: (ref) => {
        asked.push(ref)
        return Promise.resolve(written)
      },
    }
    await check(["--base", "v0.9.0"], given)
    expect(asked).toEqual(["v0.9.0"])
  })

  it("passes, saying so, before any release has a contract", async () => {
    expect(await check([], sources(undefined, written))).toEqual({
      code: 0,
      out: `v1.0.0 has no ${contractPath}: the first release that has one is the baseline.`,
    })
  })

  it("refuses arguments it doesn't know", async () => {
    await expect(check(["--bsae", "v1"], sources(written, written))).rejects.toThrow("Usage")
  })

  describe("over git", () => {
    const directory = mkdtempSync(join(tmpdir(), "contract-check-"))
    afterAll(() => rmSync(directory, { recursive: true, force: true }))
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      })
    const put = (content: string) => {
      mkdirSync(join(directory, "contract/protocol"), { recursive: true })
      writeFileSync(join(directory, contractPath), content)
    }

    it("reads the newest release's contract, and a release from before one as none", async () => {
      git("init", "--quiet", "--initial-branch=main")
      writeFileSync(join(directory, "README"), "before\n")
      git("add", ".")
      git("commit", "--quiet", "-m", "before contracts")
      git("tag", "v1.0.0")
      expect(await gitSources(directory).released("v1.0.0")).toBeUndefined()

      put(written)
      git("add", ".")
      git("commit", "--quiet", "-m", "a contract")
      git("tag", "v1.1.0")
      put(without("projects.rename", { revision: contract.revision + 1 }))
      const lines: string[] = []
      const code = await main([], gitSources(directory), (line) => lines.push(line))
      expect(code).toBe(1)
      expect(lines.join("\n")).toContain("Contract compared with v1.1.0")
    })
  })
})
