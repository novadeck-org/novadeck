import { spawn } from "node:child_process"
import { once } from "node:events"

import { describe, expect, it } from "../test.js"
import { parsePs, parseWindows, processLine, runningProcesses, treeOf } from "./processes.js"

const running = (pid: number, parent: number) => ({ pid, parent, command: `p${pid}` })

describe("the processes a failed test's trace names", () => {
  // Windows' list takes half a minute on CI: `agents/codex.test.ts` runs it there.
  it.skipIf(process.platform === "win32")(
    "finds a child this process started, by its command line",
    async () => {
      const marker = "novadeck-processes-test-marker"
      const script = `/* ${marker} */ setInterval(() => {}, 1000)`
      const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" })
      try {
        await once(child, "spawn")
        const tree = treeOf(await runningProcesses(), process.pid)
        const found = tree.find(({ pid }) => pid === child.pid)
        expect(found?.parent).toBe(process.pid)
        expect(found?.command).toContain(marker)
      } finally {
        child.kill("SIGKILL")
      }
    },
  )

  it("walks a tree from its root, and leaves out the rest", () => {
    const list = [running(1, 0), running(2, 1), running(3, 2), running(4, 1), running(9, 8)]
    expect(treeOf(list, 1).map(({ pid }) => pid)).toEqual([1, 2, 4, 3])
    expect(treeOf(list, 3).map(({ pid }) => pid)).toEqual([3])
    expect(treeOf(list, 7)).toEqual([])
  })

  it("ends where a stale parent id makes a loop, as Windows can", () => {
    expect(treeOf([running(1, 2), running(2, 1)], 1).map(({ pid }) => pid)).toEqual([1, 2])
  })

  it("reads Windows' list, of one or many", () => {
    const row = { pid: 7, parent: 3, command: "codex.exe --x" }
    expect(parseWindows(JSON.stringify(row))).toEqual([row])
    expect(parseWindows(JSON.stringify([row, row]))).toEqual([row, row])
  })

  it("reads ps's lines, whatever their padding", () => {
    expect(parsePs("  12    1 /a path/node a.js --x\n\n 3 1 sh\n")).toEqual([
      { pid: 12, parent: 1, command: "/a path/node a.js --x" },
      { pid: 3, parent: 1, command: "sh" },
    ])
  })

  it("cuts a long command line in a trace's line", () => {
    const line = processLine({ pid: 1, parent: 0, command: "y".repeat(1000) })
    expect(line.length).toBeLessThan(320)
  })
})
