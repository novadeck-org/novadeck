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
  releases: () => Promise.resolve([newest]),
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

  // A new value of an input enum (`agents.set`'s agent), as `inputEnum` writes it into the JSON.
  describe("with a new input value", () => {
    const next = contract.revision + 1
    const withAgent = (mark: Record<string, number> | undefined): string => {
      const procedure = contract.procedures["agents.set"]!
      const input = procedure.input as { properties: Record<string, Record<string, unknown>> }
      const agent = input.properties.agent!
      const grown = {
        ...agent,
        enum: [...(agent.enum as string[]), "opencode"],
        ...(mark ? { "x-since": mark } : {}),
      }
      const properties = { ...input.properties, agent: grown }
      const procedures = {
        ...contract.procedures,
        "agents.set": { ...procedure, input: { ...input, properties } },
      }
      return JSON.stringify({ ...contract, revision: next, procedures })
    }

    it("passes one marked since a later revision, and lists it for UIs to ask for", async () => {
      const { code, out } = await check([], sources(written, withAgent({ opencode: next })))
      expect(code).toBe(0)
      expect(out).toContain(`agents.set agent "opencode" since ${next}`)
    })

    it("fails one left unmarked", async () => {
      const { code, out } = await check([], sources(written, withAgent(undefined)))
      expect(code).toBe(1)
      expect(out).toContain('takes "opencode", beyond')
      expect(out).toContain("raise oldestRunner")
    })
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

  it("compares with each older release still in the window, one per revision", async () => {
    // v1.2.0 took the field away; v1.1.0, still in the window, had it.
    const r3 = without("projects.rename", { revision: contract.revision + 1 })
    const now = { ...(JSON.parse(r3) as ContractSnapshot), revision: contract.revision + 2 }
    const read: string[] = []
    const given: Sources = {
      releases: () => Promise.resolve(["v1.3.0", "v1.2.0", "v1.1.0", "v1.0.0"]),
      released: (ref) => {
        read.push(ref)
        const held: Record<string, string> = { "v1.3.0": r3, "v1.2.0": r3, "v1.1.0": written }
        return Promise.resolve(held[ref])
      },
      current: () => Promise.resolve(JSON.stringify(now)),
    }
    const { code, out } = await check([], given)
    expect(read).toEqual(["v1.3.0", "v1.2.0", "v1.1.0", "v1.0.0"])
    expect(code).toBe(1)
    expect(out).toContain("and 1 older release(s) still in the window")
    expect(out).toContain(`Leaves peers of v1.1.0 (revision ${contract.revision}) behind:`)
  })

  // A pull request's base: merged, the next release ships it, and no release holds it yet.
  describe("with a base no release holds yet", () => {
    // v1.0.0 has no projects.rename; the base added it, and the change takes it away again.
    const released = without("projects.rename", { revision: contract.revision })
    const based = JSON.stringify({ ...contract, revision: contract.revision + 1 })
    const after = without("projects.rename", { revision: contract.revision + 2 })
    const given = (base: string, current: string): Sources => ({
      releases: () => Promise.resolve(["v1.0.0"]),
      released: (ref) => Promise.resolve(ref === "base" ? base : released),
      current: () => Promise.resolve(current),
    })

    it("fails a change the releases take that leaves the base's UIs behind", async () => {
      // The releases alone take it: the release never had what it took away.
      expect((await check([], given(based, after))).code).toBe(0)
      const { code, out } = await check(["--peer", "base"], given(based, after))
      expect(code).toBe(1)
      expect(out).toContain("Contract compared with v1.0.0")
      expect(out).toContain(`Contract compared with base, at revision ${contract.revision + 1}.`)
      expect(out).toContain("projects.rename: is gone, which an older UI may still call")
      expect(out).toContain(`raise oldestClient to ${contract.revision + 2}`)
    })

    it("fails a change to the base's contract that keeps the base's revision", async () => {
      const kept = without("projects.rename", { revision: contract.revision + 1 })
      const { code, out } = await check(["--peer", "base"], given(based, kept))
      expect(code).toBe(1)
      expect(out).toContain(`raise it to ${contract.revision + 2}`)
    })

    it("compares once where the base holds the newest release's contract", async () => {
      const { code, out } = await check(["--peer", "base"], given(released, after))
      expect(code).toBe(0)
      expect(out).toContain("base holds v1.0.0's contract: nothing more to compare.")
    })
  })

  it("passes, saying so, before any release has a contract", async () => {
    expect(await check([], sources(undefined, written))).toEqual({
      code: 0,
      out: `v1.0.0 has no ${contractPath}: the first release that has one is the baseline.`,
    })
  })

  it("refuses arguments it doesn't know", async () => {
    for (const args of [
      ["--bsae", "v1"],
      ["--peer"],
      ["--peer", ""],
      ["--peer", "--base"],
      ["--peer", "a", "--peer", "b"],
    ])
      // eslint-disable-next-line no-await-in-loop -- One refusal at a time.
      await expect(check(args, sources(written, written))).rejects.toThrow("Usage")
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
