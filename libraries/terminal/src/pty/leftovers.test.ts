import { spawn } from "node:child_process"

import { describe as context, describe, expect, it, onTestFinished } from "vitest"

import { processListing, type Listed } from "./descendants.js"
import {
  endLeftovers,
  leftovers,
  listedScope,
  readScope,
  runClock,
  runStart,
  ticksNow,
} from "./leftovers.js"

// A process as a listing shows it, started at `started` clock ticks.
const row = (
  pid: number,
  parent: number,
  started: number,
  extra: Partial<Listed> = {},
): Listed => ({
  pid,
  parent,
  group: pid,
  foreground: 0,
  started: String(started),
  zombie: false,
  ...extra,
})

// A terminal's scope: its shell 10 started at 100, an agent run from 500 to 900.
const shell = row(10, 5, 100)
const runs = [{ since: 500, until: 900 }]
const pids = (found: readonly { pid: number }[]) => found.map(({ pid }) => pid).toSorted()

describe("what an agent left in its terminal's scope", () => {
  context("while the shell runs", () => {
    it("is what started detached during the agent's run, with all under it", () => {
      const rows = [
        shell,
        row(20, 10, 500), // the agent
        row(30, 1, 600), // a server it started with setsid, adopted by init
        row(31, 30, 950), // that server's worker, started after the agent left
        row(40, 2000, 700), // one adopted by a subreaper outside the scope
      ]
      const found = leftovers({
        rows,
        members: [10, 20, 30, 31, 40],
        runs,
        shell: 10,
      })
      expect(pids(found)).toEqual([30, 31, 40])
    })

    it("leaves the shell's own tree to its hangup and the agent's follow", () => {
      const rows = [shell, row(20, 10, 500), row(21, 20, 600), row(22, 21, 700)]
      expect(leftovers({ rows, members: [10, 20, 21, 22], runs, shell: 10 })).toEqual([])
    })

    it("leaves out what a follow still waits on", () => {
      const rows = [shell, row(30, 1, 600), row(31, 1, 610)]
      const found = leftovers({
        rows,
        members: [10, 30, 31],
        runs,
        shell: 10,
        skip: new Set(["30:600"]),
      })
      expect(pids(found)).toEqual([31])
    })
  })

  context("once the shell has gone", () => {
    it("is what the agent started, whatever it was under", () => {
      const rows = [row(20, 1, 500), row(21, 1, 600), row(22, 21, 700)]
      expect(pids(leftovers({ rows, members: [20, 21, 22], runs }))).toEqual([20, 21, 22])
    })

    it("spares what the person started before the agent, or after it left, with all under each", () => {
      const rows = [
        row(50, 1, 300), // a `nohup` of the person's before the agent
        row(51, 50, 600), // what it started while the agent ran
        row(60, 1, 1000), // one the person started once the agent had left
        row(61, 60, 1100),
        row(30, 1, 600), // the agent's
      ]
      expect(pids(leftovers({ rows, members: [50, 51, 60, 61, 30], runs }))).toEqual([30])
    })

    it("counts what started during any of several runs, and all of a run still open", () => {
      const twice = [{ since: 200, until: 300 }, { since: 800 }]
      const rows = [row(30, 1, 250), row(31, 1, 500), row(32, 1, 5000)]
      expect(pids(leftovers({ rows, members: [30, 31, 32], runs: twice }))).toEqual([30, 32])
    })
  })

  it("spares what the harness runs apart from the terminal, with all under it", () => {
    const rows = [
      row(70, 1, 600), // Claude Code's background service
      row(71, 70, 650), // one of its background sessions
      row(72, 71, 700), // what that session runs
      row(30, 1, 600),
    ]
    const found = leftovers({
      rows,
      members: [70, 71, 72, 30],
      runs,
      apart: [{ pid: 70, started: "600" }],
    })
    expect(pids(found)).toEqual([30])
  })

  it("never names one apart by its pid alone", () => {
    const rows = [row(70, 1, 600)]
    const found = leftovers({
      rows,
      members: [70],
      runs,
      apart: [{ pid: 70, started: "601" }],
    })
    expect(pids(found)).toEqual([70])
  })

  it("is never a process outside the scope, as one `systemd-run` moved to a scope of its own", () => {
    const rows = [row(30, 1, 600), row(31, 30, 650)]
    // 31 started under 30, then was moved to a scope of its own.
    expect(pids(leftovers({ rows, members: [30], runs }))).toEqual([30])
  })

  it("is nothing where no agent ran, and never a zombie or init", () => {
    const rows = [row(30, 1, 600), row(31, 1, 600, { zombie: true }), row(1, 0, 0)]
    expect(leftovers({ rows, members: [30, 31, 1], runs: [] })).toEqual([])
    expect(pids(leftovers({ rows, members: [30, 31, 1], runs }))).toEqual([30])
  })

  it("takes no parent that started after its child, whose recorded parent's pid it took", () => {
    // Windows keeps 30's parent, 25, after 25 ended; 25 is now a later process, in the scope.
    const rows = [shell, row(25, 10, 800), row(30, 25, 600), row(31, 30, 650)]
    const found = leftovers({
      rows,
      members: [10, 25, 30, 31],
      runs,
      shell: 10,
    })
    expect(pids(found)).toEqual([30, 31])
  })

  it("is nothing for a start that isn't Linux's clock ticks", () => {
    const rows = [{ ...row(30, 1, 600), started: "Mon Nov 23 01:00:00 2026" }]
    expect(leftovers({ rows, members: [30], runs })).toEqual([])
  })
})

describe("where an agent's run begins", () => {
  it("is the agent's own start, never a wrapper's or a shell's above it", () => {
    const rows = [row(10, 5, 100), row(15, 10, 400), row(20, 15, 450)]
    expect(runStart(rows, 20)).toBe(450)
  })

  it("is unknown for a pid the listing doesn't show, as a sandbox's own", () => {
    expect(runStart([row(10, 5, 100)], 3)).toBeUndefined()
    expect(runStart([row(20, 5, 100, { zombie: true })], 20)).toBeUndefined()
  })
})

describe("now, in clock ticks", () => {
  it("is the time since boot, through any suspend, as a process's start counts it", () => {
    expect(ticksNow(() => "62427.76 1234567.89\n")).toBe(6_242_776)
  })

  it("is unknown where it can't be read", () => {
    expect(
      ticksNow(() => {
        throw new Error("no /proc")
      }),
    ).toBeUndefined()
    expect(ticksNow(() => "garbage")).toBeUndefined()
  })

  it.skipIf(process.platform !== "linux")("is after a process started a moment ago", async () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" })
    onTestFinished(() => void child.kill("SIGKILL"))
    await new Promise((resolve) => setTimeout(resolve, 50))
    const rows = await processListing("linux", 0)()
    const started = Number(rows!.find((one) => one.pid === child.pid)!.started)
    const now = ticksNow()!
    expect(now).toBeGreaterThanOrEqual(started)
    expect(now - started).toBeLessThan(100)
  })
})

describe("now, in a platform's clock for a process's start", () => {
  it("is Windows' wall clock in milliseconds, as its creation times count", () => {
    const before = Date.now()
    expect(runClock("win32")).toBeGreaterThanOrEqual(before)
    expect(runClock("darwin")).toBeUndefined()
  })
})

describe("reading a scope", () => {
  it("lists one that lists its own, as a Windows job, with its members", async () => {
    const rows = [row(30, 1, 600), row(31, 30, 650)]
    expect(await listedScope(() => Promise.resolve(rows))).toEqual({
      rows,
      members: [30, 31],
    })
    expect(await listedScope(() => Promise.resolve([]))).toBeUndefined()
    expect(await listedScope(() => Promise.resolve(undefined))).toBeUndefined()
  })

  it("is nothing where its members or the processes can't be read, or it is empty", async () => {
    const rows = [row(1, 0, 0)]
    expect(
      await readScope(
        () => Promise.resolve(rows),
        () => Promise.resolve(undefined),
      ),
    ).toBe(undefined)
    expect(
      await readScope(
        () => Promise.resolve(rows),
        () => Promise.resolve([]),
      ),
    ).toBe(undefined)
    expect(
      await readScope(
        () => Promise.resolve(undefined),
        () => Promise.resolve([1]),
      ),
    ).toBe(undefined)
    expect(
      await readScope(
        () => Promise.resolve(rows),
        () => Promise.resolve([1]),
      ),
    ).toEqual({
      rows,
      members: [1],
    })
  })
})

// A real process of this test's own, a node that ignores what `ignores` names, once it is up.
const program = async (ignores: readonly string[]) => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `for (const s of ${JSON.stringify(ignores)}) process.on(s, () => {}); console.log("up"); setInterval(() => {}, 1000)`,
      "novadeck-leftovers-test",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  )
  onTestFinished(() => void child.kill("SIGKILL"))
  await new Promise((resolve) => child.stdout.once("data", resolve))
  return child
}

const ended = (child: ReturnType<typeof spawn>) =>
  new Promise<NodeJS.Signals | null>((resolve) =>
    child.once("exit", (_code, signal) => resolve(signal)),
  )

describe("ending what an agent left where its scope ends a process itself", () => {
  it("ends what it finds at once, by its pid and start, with no signal", async () => {
    const asked: string[][] = []
    const found = [{ pid: 30, started: "600" }]
    const done = await endLeftovers(
      () => Promise.resolve(found),
      undefined,
      async (ones) => void asked.push(ones.map(({ pid, started }) => `${pid}:${started}`)),
    )
    expect(done).toEqual(found)
    expect(asked).toEqual([["30:600"]])
  })

  it("ends nothing where it finds nothing", async () => {
    let asked = false
    const end = async () => {
      asked = true
    }
    expect(await endLeftovers(() => Promise.resolve(undefined), undefined, end)).toEqual([])
    expect(await endLeftovers(() => Promise.resolve([]), undefined, end)).toEqual([])
    expect(asked).toBe(false)
  })
})

describe.skipIf(process.platform === "win32")("ending what an agent left", () => {
  it("asks with SIGTERM, then forces what ignores it half a second on", async () => {
    const polite = await program([])
    const stubborn = await program(["SIGTERM"])
    // Found as a listing would find them: those still running.
    const find = () =>
      Promise.resolve(
        [polite, stubborn]
          .filter((child) => child.exitCode === null && child.signalCode === null)
          .map((child) => ({ pid: child.pid!, started: "x" })),
      )
    const exits = Promise.all([ended(polite), ended(stubborn)])
    const began = performance.now()
    await endLeftovers(find)
    expect(await exits).toEqual(["SIGTERM", "SIGKILL"])
    expect(performance.now() - began).toBeGreaterThanOrEqual(450)
  })

  it("forces it sooner where a quit's bound comes first", async () => {
    const stubborn = await program(["SIGTERM"])
    const exit = ended(stubborn)
    const began = performance.now()
    await endLeftovers(
      () => Promise.resolve([{ pid: stubborn.pid!, started: "x" }]),
      () => Date.now() + 100,
    )
    expect(await exit).toBe("SIGKILL")
    expect(performance.now() - began).toBeLessThan(400)
  })

  it("forces only what it asked first, leaving what it finds later to be asked", async () => {
    const first = await program(["SIGTERM"])
    const later = await program(["SIGTERM"])
    let asked = 0
    const exit = ended(first)
    await endLeftovers(() => {
      asked += 1
      const found = [{ pid: first.pid!, started: "x" }]
      return Promise.resolve(asked === 1 ? found : [...found, { pid: later.pid!, started: "x" }])
    })
    expect(await exit).toBe("SIGKILL")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(later.signalCode).toBeNull()
  })

  it("gives up finding them by a quit's bound", async () => {
    const began = Date.now()
    const found = await endLeftovers(
      () => new Promise(() => {}),
      () => began + 100,
    )
    expect(found).toEqual([])
    expect(Date.now() - began).toBeLessThan(400)
  })

  it("signals nothing where nothing is found, and nothing more where it is found again gone", async () => {
    const stubborn = await program(["SIGTERM"])
    expect(await endLeftovers(() => Promise.resolve(undefined))).toEqual([])
    let asked = 0
    // Found at first, then no longer the process found, as its pid had been taken.
    await endLeftovers(() => {
      asked += 1
      return Promise.resolve(asked === 1 ? [{ pid: stubborn.pid!, started: "x" }] : [])
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(stubborn.exitCode).toBeNull()
    expect(stubborn.signalCode).toBeNull()
  })
})
