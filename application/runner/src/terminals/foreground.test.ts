import { describe, expect, it } from "../test.js"
import { parseCommandLine, parseProcessStat, sampleForeground } from "./foreground.js"

const cmdline = (...args: string[]): Buffer => Buffer.from(`${args.join("\0")}\0`)

describe("Linux foreground inspection", () => {
  it("parses the controlling terminal and foreground group after a parenthesized command", () => {
    expect(parseProcessStat("42 (node ) helper) S 1 42 42 34816 99 0")).toEqual({
      pgrp: 42,
      tty: 34816,
      tpgid: 99,
    })
    expect(parseProcessStat("42 (node) S 1 invalid 42 34816 99 0")).toBeNull()
    expect(parseProcessStat("broken")).toBeNull()
  })

  it("splits a command line into arguments, keeping empty ones", () => {
    expect(parseCommandLine(cmdline("/usr/bin/node", "/a path/bin/codex", "", "--yes"))).toEqual([
      "/usr/bin/node",
      "/a path/bin/codex",
      "",
      "--yes",
    ])
    expect(parseCommandLine(Buffer.alloc(0))).toEqual([])
  })

  it("drops the NUL padding a retitled process leaves, keeping empty arguments before it", () => {
    const retitled = Buffer.concat([Buffer.from("claude"), Buffer.alloc(200)])
    expect(parseCommandLine(retitled)).toEqual(["claude"])
    expect(parseCommandLine(Buffer.from("node\0\0--yes\0\0\0"))).toEqual(["node", "", "--yes"])
  })

  it("truncates a command line to what the protocol accepts", () => {
    const args = parseCommandLine(cmdline(...Array.from({ length: 70 }, () => "x".repeat(5000))))
    expect(args).toHaveLength(64)
    expect(args.every((arg) => arg.length === 4096)).toBe(true)
  })

  it.skipIf(process.platform !== "linux")(
    "reads the command line again only once the foreground group or name changes",
    () => {
      const child = { pid: process.pid, process: "node" }
      const first = sampleForeground(child, undefined)
      expect(first.process?.name).toBe("node")
      const cached = { ...first, process: { name: "node", argv: ["cached"] } }
      expect(sampleForeground(child, cached)).toBe(cached)
      expect(sampleForeground({ ...child, process: "other" }, cached).process).toEqual({
        name: "other",
        argv: first.process?.argv ?? null,
      })
      expect(sampleForeground(child, { ...cached, group: -1 }).process?.argv).not.toEqual([
        "cached",
      ])
    },
  )
})
