import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import { reap } from "./reap.js"
import { list } from "./reap/windows.js"

describe.skipIf(process.platform !== "linux")("reap", () => {
  it("ends a process left in the sandbox, naming it, and one stopped as stopped", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const sandbox = { root, home: join(root, "home"), started: 0 }
    const leak = () => {
      const child = spawn("sleep", ["60"], { cwd: root, env: {}, stdio: "ignore" })
      onTestFinished(() => {
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
  it("ends what runs in the sandbox or has its home, naming it, and nothing else", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-")))
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-elsewhere-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
    onTestFinished(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5 }))
    const sandbox = { root, home: join(root, "home"), started: Date.now() }
    const start = (cwd: string, env: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
        cwd,
        env: { SystemRoot: process.env.SystemRoot, ...env },
        stdio: "ignore",
      })
      onTestFinished(() => {
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
      const listed = (await list(sandbox)).map((one) => one.pid)
      if (listed.includes(inside.pid!) && listed.includes(homed.pid!)) break
      if (Date.now() > deadline) throw new Error(`Not listed in 30 s: only ${listed.join(", ")}`)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const leftovers = await reap(sandbox)

    // Each named with its recorded parent, this worker, which still runs.
    const parent = `parent node#${process.pid} running`
    expect(leftovers.toSorted()).toEqual(
      [`node.exe (${inside.pid}, ${parent})`, `node.exe (${homed.pid}, ${parent})`].toSorted(),
    )
    expect(other.exitCode).toBeNull()
    expect(await reap(sandbox)).toEqual([])
  }, 60_000)
})

describe.skipIf(process.platform !== "darwin")("reap on macOS", () => {
  it("ends what runs in the sandbox or has its home, naming it, and nothing else", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-")))
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-elsewhere-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    onTestFinished(() => rmSync(elsewhere, { recursive: true, force: true }))
    const sandbox = { root, home: join(root, "home"), started: Date.now() }
    const start = (cwd: string, env: NodeJS.ProcessEnv) => {
      // Node rather than a system program such as sleep: macOS shows no environment of its
      // own programs, and the programs under test are never one. Each in a group of its own, as
      // a program in its terminal is: one stopped in the tests' own group would stop with it
      // whatever job control does to that group.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
        cwd,
        env,
        stdio: "ignore",
        detached: true,
      })
      onTestFinished(() => {
        child.kill("SIGKILL")
      })
      return child
    }
    const name = basename(process.execPath)
    const inside = start(root, {})
    const stopped = start(root, {})
    process.kill(stopped.pid!, "SIGSTOP")
    const homed = start(elsewhere, { HOME: sandbox.home })
    const other = start(elsewhere, { HOME: elsewhere })
    // Each has started, so ps and lsof see it.
    await new Promise((resolve) => setTimeout(resolve, 500))

    const leftovers = await reap(sandbox)

    expect(leftovers.toSorted()).toEqual(
      [
        `${name} (${inside.pid})`,
        `${name} (${stopped.pid}, stopped)`,
        `${name} (${homed.pid})`,
      ].toSorted(),
    )
    expect(other.exitCode).toBeNull()
    expect(await reap(sandbox)).toEqual([])
  }, 30_000)

  it("ends a system program one of them started elsewhere, which shows no environment", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-")))
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-elsewhere-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    onTestFinished(() => rmSync(elsewhere, { recursive: true, force: true }))
    const sandbox = { root, home: join(root, "home"), started: Date.now() }
    // A shell of the sandbox's, in a group of its own, that leaves sleep running elsewhere:
    // macOS shows neither's environment, and sleep's folder isn't the sandbox's.
    const shell = spawn("/bin/sh", ["-c", `cd '${elsewhere}' && /bin/sleep 60 & wait`], {
      cwd: root,
      env: {},
      stdio: "ignore",
      detached: true,
    })
    onTestFinished(() => {
      try {
        process.kill(-shell.pid!, "SIGKILL")
      } catch {
        // Ended by the reaping, as it should be.
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 500))

    const leftovers = await reap(sandbox)

    // The shell, the subshell it runs the backgrounded line in, and sleep.
    expect(leftovers.map((one) => one.replace(/ \(.*/, "")).toSorted()).toEqual([
      "sh",
      "sh",
      "sleep",
    ])
    expect(await reap(sandbox)).toEqual([])
  }, 30_000)

  it("ends one found through its parent though that parent has gone since, and it ignores SIGTERM", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-")))
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-elsewhere-")))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    onTestFinished(() => rmSync(elsewhere, { recursive: true, force: true }))
    const sandbox = { root, home: join(root, "home"), started: Date.now() }
    // A shell of the sandbox's starts sleep elsewhere, deaf to SIGTERM, and leaves within
    // the reaper's 3 s grace, 2 s in, long enough for a slow first look to find it: sleep is
    // the sandbox's only through the shell, found before it went.
    const shell = spawn(
      "/bin/sh",
      ["-c", `(trap '' TERM; cd '${elsewhere}' && exec /bin/sleep 60) & /bin/sleep 2`],
      { cwd: root, env: {}, stdio: "ignore", detached: true },
    )
    onTestFinished(() => {
      try {
        process.kill(-shell.pid!, "SIGKILL")
      } catch {
        // Ended by the reaping, as it should be.
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 500))

    const leftovers = await reap(sandbox)

    const sleeping = leftovers.filter((one) => one.startsWith("sleep ("))
    expect(sleeping).toHaveLength(1)
    const pid = Number(/\((\d+)/.exec(sleeping[0]!)![1])
    // Gone once launchd has reaped it, which may take a moment after the SIGKILL.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/), { timeout: 2_000 })
    expect(await reap(sandbox)).toEqual([])
  }, 30_000)
})
