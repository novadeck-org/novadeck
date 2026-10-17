import { spawn } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import {
  parseDarwinFolders,
  parseDarwinProcesses,
  reap,
  sandboxed,
  endTree,
  endWindows,
  sandboxProcesses,
} from "./reap.js"

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
      const listed = (await sandboxProcesses(sandbox)).map((one) => one.pid)
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

// A pid no process has, so a tree of it reads as ended at once: above Linux's pid_max, and a
// multiple of 4, as Windows reads a pid without its two low bits.
const gone = 2 ** 22 + 8

describe("ending a Windows process's tree", () => {
  const reader = (tree: readonly { pid: number; startedAt: number }[] | undefined) => {
    const calls = { read: [] as number[], end: [] as unknown[] }
    return {
      calls,
      trees: {
        read: async (pid: number) => {
          calls.read.push(pid)
          return tree
        },
        end: async (members: readonly unknown[]) => {
          calls.end.push(members)
        },
      },
    }
  }

  it("ends the tree its reader reads, rooted at the process found", async () => {
    const tree = [
      { pid: gone, startedAt: 100 },
      { pid: gone + 1, startedAt: 101 },
    ]
    const { calls, trees } = reader(tree)
    const killed: number[] = []

    await endTree({ pid: gone, start: 100 }, trees, async (pid) => {
      killed.push(pid)
    })

    expect(calls.read).toEqual([gone])
    expect(calls.end).toEqual([tree])
    expect(killed).toEqual([])
  })

  it("ends nothing where the root is a later process given the same pid", async () => {
    const { calls, trees } = reader([{ pid: gone, startedAt: 200 }])
    const killed: number[] = []

    await endTree({ pid: gone, start: 100 }, trees, async (pid) => {
      killed.push(pid)
    })

    expect(calls.end).toEqual([])
    expect(killed).toEqual([])
  })

  it("ends the process alone when asked, or forcibly with no reader to read its tree", async () => {
    const { calls, trees } = reader([{ pid: gone, startedAt: 100 }])
    const terminated: number[] = []
    const terminate = (pid: number) => {
      terminated.push(pid)
    }

    await endWindows({ pid: gone, start: 100 }, false, trees, terminate)
    await endWindows({ pid: gone, start: 100 }, true, undefined, terminate)
    await endWindows({ pid: gone, start: 100 }, true, trees, terminate)

    // Only the forcible end with a reader went to the tree.
    expect(terminated).toEqual([gone, gone])
    expect(calls.read).toEqual([gone])
  })

  it("ends it by recorded parents where its reader can't read the tree", async () => {
    const { trees } = reader(undefined)
    const killed: number[] = []

    await endTree({ pid: gone, start: 100 }, trees, async (pid) => {
      killed.push(pid)
    })

    expect(killed).toEqual([gone])
  })
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

describe("macOS's process listing", () => {
  it("reads each process's pid, parent, group, state, start and command's name", () => {
    const output = [
      "  412     1   412 Ss   Thu Oct  9 11:03:47 2026     /bin/bash",
      "51234   412 51234 T    Fri Oct 10 09:00:01 2026     /Applications/Some App.app/Contents/MacOS/Some App",
      "  777   412   412 Z    Thu Oct  9 11:03:48 2026     (node)",
      "not a process",
    ].join("\n")

    expect(parseDarwinProcesses(output)).toEqual([
      {
        pid: 412,
        ppid: 1,
        pgid: 412,
        comm: "bash",
        start: new Date(2026, 9, 9, 11, 3, 47).getTime(),
        stopped: false,
        zombie: false,
      },
      {
        pid: 51234,
        ppid: 412,
        pgid: 51234,
        comm: "Some App",
        start: new Date(2026, 9, 10, 9, 0, 1).getTime(),
        stopped: true,
        zombie: false,
      },
      {
        pid: 777,
        ppid: 412,
        pgid: 412,
        comm: "(node)",
        start: new Date(2026, 9, 9, 11, 3, 48).getTime(),
        stopped: false,
        zombie: true,
      },
    ])
  })

  it("counts a found process's children and its group's, however deep, but never the tests' group", () => {
    const processes = [
      // A program found by its folder, a child it started elsewhere, and that child's own.
      { pid: 10, ppid: 5, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 11 },
      { pid: 12, ppid: 11, pgid: 11 },
      // A background job of the program's group, its parent gone.
      { pid: 13, ppid: 1, pgid: 10 },
      // The tests' own group, which holds a found process's parent and a stray of its own.
      { pid: 20, ppid: 1, pgid: 20 },
      { pid: 21, ppid: 20, pgid: 20 },
      { pid: 22, ppid: 20, pgid: 20 },
      // Another program altogether.
      { pid: 30, ppid: 1, pgid: 30 },
    ]

    expect([...sandboxed(processes, new Set([10, 21]), 20)].toSorted((a, b) => a - b)).toEqual([
      10, 11, 12, 13, 21,
    ])
  })

  it("reads each process's working folder from lsof's fields", () => {
    const output = ["p412", "fcwd", "n/private/tmp/sandbox test", "p413", "fcwd", "n/"].join("\n")

    expect(parseDarwinFolders(output)).toEqual(
      new Map([
        [412, "/private/tmp/sandbox test"],
        [413, "/"],
      ]),
    )
  })
})
