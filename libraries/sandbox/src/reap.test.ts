import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { describe, expect, it, onTestFinished, vi } from "vitest"

import { reap } from "./reap.js"
import { list } from "./reap/windows.js"
import { createSandbox } from "./sandbox.js"

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

describe.skipIf(process.platform !== "linux")("reap on Linux, in a sandbox", () => {
  const made = () => {
    const sandbox = createSandbox({ prefix: "sandbox-reaped-", bins: [] })
    onTestFinished(() => rmSync(sandbox.root, { recursive: true, force: true }))
    return sandbox
  }
  const elsewhere = () => {
    const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "sandbox-reaped-elsewhere-")))
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }))
    return folder
  }
  // Started, and ended should the reaping not have, with its group for one in a group of
  // its own (`detached`), as a program in a terminal is, and so what it started.
  const started = async (child: ChildProcess, grouped = false) => {
    onTestFinished(() => {
      try {
        process.kill(grouped ? -child.pid! : child.pid!, "SIGKILL")
      } catch {
        // Ended by the reaping, as it should be.
      }
    })
    await once(child, "spawn")
    return child
  }
  const sleep = (cwd: string, env: NodeJS.ProcessEnv) =>
    started(spawn("sleep", ["60"], { cwd, env, stdio: "ignore" }))
  // The pids a shell prints, one a line, once it has printed `count` of them.
  const printed = async (shell: ChildProcess, count: number): Promise<number[]> => {
    let out = ""
    for await (const chunk of shell.stdout!) {
      out += String(chunk)
      const pids = out.split("\n").filter(Boolean).map(Number)
      if (pids.length >= count) return pids
    }
    throw new Error(`The shell printed ${JSON.stringify(out)} and ended`)
  }

  it("ends what started since it was made, inside it or with its home, and nothing that started before", async () => {
    // Started before the sandbox, in a folder moved into it since: inside, but older.
    const early = elsewhere()
    const before = await sleep(early, {})
    // A clock tick (10 ms) and more, so the sandbox's start is past this one's.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const sandbox = made()
    renameSync(early, join(sandbox.project, "early"))
    expect(readlinkSync(`/proc/${before.pid}/cwd`)).toBe(join(sandbox.project, "early"))
    const outside = elsewhere()
    const inside = await sleep(sandbox.project, {})
    const homed = await sleep(outside, sandbox.env)
    const other = await sleep(outside, { HOME: outside })

    const leftovers = await reap(sandbox)

    expect(leftovers.toSorted()).toEqual(
      [`sleep (${inside.pid})`, `sleep (${homed.pid})`].toSorted(),
    )
    expect(before.exitCode).toBeNull()
    expect(other.exitCode).toBeNull()
    expect(await reap(sandbox)).toEqual([])
  })

  it("ends a program one of them started elsewhere with no HOME, through its parent", async () => {
    const sandbox = made()
    const outside = elsewhere()
    const shell = await started(
      spawn(
        "/bin/sh",
        ["-c", `sh -c 'cd "$1" && echo $$ && exec env -i sleep 60' _ '${outside}' & wait`],
        {
          cwd: sandbox.project,
          env: {},
          stdio: ["ignore", "pipe", "ignore"],
          detached: true,
        },
      ),
      true,
    )
    const [sleeping] = await printed(shell, 1)
    expect(readlinkSync(`/proc/${sleeping}/cwd`)).toBe(outside)

    const leftovers = await reap(sandbox)

    expect(leftovers).toContain(`sleep (${sleeping})`)
    expect(leftovers).toContain(`sh (${shell.pid})`)
    expect(await reap(sandbox)).toEqual([])
  })

  // The PATH the test runs python3 on.
  const path = { PATH: "/usr/bin:/bin" }
  const python = spawnSync("python3", ["-c", ""], { env: path }).status === 0

  it.skipIf(!python)(
    "ends a child whose folder and environment can't be read, as a non-dumpable one's can't",
    async () => {
      const sandbox = made()
      // PR_SET_DUMPABLE (4) to 0, as ssh-agent and setuid programs are, then its pid.
      const hidden =
        "import ctypes,os,time;ctypes.CDLL(None).prctl(4,0,0,0,0);print(os.getpid(),flush=True);time.sleep(60)"
      const shell = await started(
        spawn("/bin/sh", ["-c", `python3 -c '${hidden}' & wait`], {
          cwd: sandbox.project,
          env: path,
          stdio: ["ignore", "pipe", "ignore"],
          detached: true,
        }),
        true,
      )
      const [pid] = await printed(shell, 1)
      // Hidden from its own user, as the kernel hides a non-dumpable process.
      expect(() => readlinkSync(`/proc/${pid}/cwd`)).toThrow(/EACCES/)

      const leftovers = await reap(sandbox)

      expect(leftovers.filter((one) => one.includes(`(${pid})`))).toHaveLength(1)
      expect(leftovers).toContain(`sh (${shell.pid})`)
      expect(await reap(sandbox)).toEqual([])
    },
  )
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

    // Each named with its recorded parent, this worker, which still runs, then with its
    // program's path and its command line.
    const parent = `parent node#${process.pid} running`
    expect(leftovers).toHaveLength(2)
    for (const child of [inside, homed]) {
      const one = leftovers.find((each) => each.startsWith(`node.exe (${child.pid}, ${parent}) `))
      expect(one?.toLowerCase()).toContain(` at ${process.execPath.toLowerCase()} as `)
      expect(one).toContain("setTimeout")
    }
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
