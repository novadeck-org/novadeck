import { spawn } from "node:child_process"

import { relayPath } from "@novadeck/relay"
import { anyRunning, Trees } from "@novadeck/terminal/pty"

import { describe, expect, it } from "../test.js"

// The terminal library's process trees, read and ended through the runner's own relay.
describe("Windows process trees, through the relay", () => {
  it.runIf(process.platform === "win32")(
    "find what an ended process left running, read again from it by its start",
    async () => {
      // cmd starts a ping, then is ended alone, as a shell is: the ping runs on, orphaned.
      const shell = spawn("cmd.exe", ["/d", "/c", "ping -n 60 127.0.0.1 >nul"], {
        stdio: "ignore",
        windowsHide: true,
      })
      const read = new Trees(async () => relayPath)
      await expect
        .poll(async () => (await read.read(shell.pid!))?.length ?? 0, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(3)
      const root = (await read.read(shell.pid!))![0]!
      process.kill(shell.pid!)
      await expect.poll(() => anyRunning([root]), { timeout: 10_000 }).toBe(false)
      const left = (await read.read(root)) ?? []
      expect(left.length).toBeGreaterThan(0)
      expect(left.every(({ pid }) => pid !== root.pid)).toBe(true)
      await read.end(left)
      await expect.poll(() => anyRunning(left), { timeout: 10_000 }).toBe(false)
    },
  )

  it.runIf(process.platform === "win32")(
    "end a tree the relay read, programs it started included",
    async () => {
      // cmd, which starts a ping of its own, as a shell starts an agent.
      const shell = spawn("cmd.exe", ["/d", "/c", "ping -n 60 127.0.0.1 >nul"], {
        stdio: "ignore",
        windowsHide: true,
      })
      const read = new Trees(async () => relayPath)
      // Its ping, and the console host Windows starts for a hidden console.
      await expect
        .poll(async () => (await read.read(shell.pid!))?.length ?? 0, { timeout: 10_000 })
        .toBeGreaterThanOrEqual(3)
      const tree = (await read.read(shell.pid!))!
      expect(tree[0]?.pid).toBe(shell.pid)
      await read.end(tree)
      await expect.poll(() => anyRunning(tree), { timeout: 10_000 }).toBe(false)
    },
  )
})
