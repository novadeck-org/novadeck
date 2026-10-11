import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "../test.js"
import { reap, sandboxProcesses } from "./reap.js"

describe.skipIf(process.platform !== "linux")("reap", () => {
  it("ends a process left in the sandbox, naming it, and one stopped as stopped", async ({
    resources,
  }) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-reap-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const sandbox = { root, home: join(root, "home"), started: 0 }
    const leak = () => {
      const child = spawn("sleep", ["60"], { cwd: root, env: {}, stdio: "ignore" })
      resources.defer(() => {
        child.kill("SIGKILL")
      })
      return child.pid!
    }
    const running = leak()
    const stopped = leak()
    process.kill(stopped, "SIGSTOP")

    const leftovers = await reap(sandbox)

    expect(leftovers.toSorted()).toEqual(
      [`sleep (${running})`, `sleep (${stopped}, stopped)`].toSorted(),
    )
    expect(await reap(sandbox)).toEqual([])
  })
})

describe.skipIf(process.platform !== "win32")("reap on Windows", () => {
  it("ends what runs in the sandbox or has its home, naming it, and nothing else", async ({
    resources,
  }) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-reap-")))
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-reap-other-")))
    resources.defer(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    resources.defer(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
    const sandbox = { root, home: join(root, "home"), started: Date.now() }
    const start = (cwd: string, env: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
        cwd,
        env: { SystemRoot: process.env.SystemRoot, ...env },
        stdio: "ignore",
      })
      resources.defer(() => {
        child.kill()
      })
      return child
    }
    const inside = start(root, {})
    const homed = start(elsewhere, { HOME: sandbox.home })
    const other = start(elsewhere, { HOME: elsewhere })
    // Until each has started, so its parameters are there to read.
    const deadline = Date.now() + 30_000
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Looks again until both are there.
      const listed = (await sandboxProcesses(sandbox)).map((one) => one.pid)
      if (listed.includes(inside.pid!) && listed.includes(homed.pid!)) break
      if (Date.now() > deadline) throw new Error(`Not listed in 30 s: only ${listed.join(", ")}`)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const leftovers = await reap(sandbox)

    expect(leftovers.toSorted()).toEqual(
      [`node.exe (${inside.pid})`, `node.exe (${homed.pid})`].toSorted(),
    )
    expect(other.exitCode).toBeNull()
    expect(await reap(sandbox)).toEqual([])
  }, 60_000)
})
