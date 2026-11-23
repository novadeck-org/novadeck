import { spawn } from "node:child_process"

import { describe as context, describe, expect, it, onTestFinished } from "vitest"

import { processListing, type Listed } from "./descendants.js"
import {
  endLeftovers,
  leftovers,
  readScope,
  runClock,
  runStart,
  tickClock,
  ticksNow,
  wallClock,
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
// A scope's members by their pids, as Linux's cgroups tell them, with no start.
const inside = (...members: number[]) => members.map((pid) => ({ pid }))

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
      const found = leftovers({ rows, members: inside(10, 20, 30, 31, 40), runs, shell: 10 })
      expect(pids(found)).toEqual([30, 31, 40])
    })

    it("leaves the shell's own tree to its hangup and the agent's follow", () => {
      const rows = [shell, row(20, 10, 500), row(21, 20, 600), row(22, 21, 700)]
      expect(leftovers({ rows, members: inside(10, 20, 21, 22), runs, shell: 10 })).toEqual([])
    })

    context("where the scope leaves out processes it holds, as macOS's every Apple program", () => {
      it("judges a member by the start of the ancestor it runs under, never its own", () => {
        // The person's `bash` loop 50, started before the agent, restarts node 51 during the run.
        const rows = [shell, row(50, 1, 300), row(51, 50, 600)]
        expect(leftovers({ rows, members: inside(51), runs, shell: 10, partial: true })).toEqual([])
        // A scope that holds every process judges by what it holds.
        expect(pids(leftovers({ rows, members: inside(51), runs, shell: 10 }))).toEqual([51])
      })

      it("still names what runs under an ancestor the agent started", () => {
        const rows = [shell, row(60, 1, 600), row(61, 60, 700)]
        const found = leftovers({ rows, members: inside(61), runs, shell: 10, partial: true })
        expect(pids(found)).toEqual([61])
      })

      it("leaves what lies under the harness's own service, through what it doesn't hold", () => {
        // The service 70, an Apple `sh` 71 it started, and its node 72.
        const rows = [shell, row(70, 1, 600), row(71, 70, 610), row(72, 71, 620)]
        const apart = [{ pid: 70, started: "600" }]
        const found = leftovers({ rows, members: inside(70, 72), runs, apart, partial: true })
        expect(found).toEqual([])
      })
    })

    it("leaves the shell's tree by the listing, where the scope doesn't hold the shell", () => {
      // macOS's: an Apple shell's environment is hidden, so only what it started is a member.
      const rows = [shell, row(20, 10, 500), row(21, 20, 600), row(30, 1, 650)]
      const found = leftovers({ rows, members: inside(20, 21, 30), runs, shell: 10 })
      expect(pids(found)).toEqual([30])
    })

    it("leaves out what a follow still waits on", () => {
      const rows = [shell, row(30, 1, 600), row(31, 1, 610)]
      const found = leftovers({
        rows,
        members: inside(10, 30, 31),
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
      expect(pids(leftovers({ rows, members: inside(20, 21, 22), runs }))).toEqual([20, 21, 22])
    })

    it("spares what the person started before the agent, or after it left, with all under each", () => {
      const rows = [
        row(50, 1, 300), // a `nohup` of the person's before the agent
        row(51, 50, 600), // what it started while the agent ran
        row(60, 1, 1000), // one the person started once the agent had left
        row(61, 60, 1100),
        row(30, 1, 600), // the agent's
      ]
      expect(pids(leftovers({ rows, members: inside(50, 51, 60, 61, 30), runs }))).toEqual([30])
    })

    it("counts what started during any of several runs, and all of a run still open", () => {
      const twice = [{ since: 200, until: 300 }, { since: 800 }]
      const rows = [row(30, 1, 250), row(31, 1, 500), row(32, 1, 5000)]
      expect(pids(leftovers({ rows, members: inside(30, 31, 32), runs: twice }))).toEqual([30, 32])
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
      members: inside(70, 71, 72, 30),
      runs,
      apart: [{ pid: 70, started: "600" }],
    })
    expect(pids(found)).toEqual([30])
  })

  it("never names one apart by its pid alone", () => {
    const rows = [row(70, 1, 600)]
    const found = leftovers({
      rows,
      members: inside(70),
      runs,
      apart: [{ pid: 70, started: "601" }],
    })
    expect(pids(found)).toEqual([70])
  })

  it("is never a process outside the scope, as one `systemd-run` moved to a scope of its own", () => {
    const rows = [row(30, 1, 600), row(31, 30, 650)]
    // 31 started under 30, then was moved to a scope of its own.
    expect(pids(leftovers({ rows, members: inside(30), runs }))).toEqual([30])
  })

  it("is nothing where no agent ran, and never a zombie or init", () => {
    const rows = [row(30, 1, 600), row(31, 1, 600, { zombie: true }), row(1, 0, 0)]
    expect(leftovers({ rows, members: inside(30, 31, 1), runs: [] })).toEqual([])
    expect(pids(leftovers({ rows, members: inside(30, 31, 1), runs }))).toEqual([30])
  })

  it("is nothing for a start that isn't Linux's clock ticks", () => {
    const rows = [{ ...row(30, 1, 600), started: "Mon Nov 23 01:00:00 2026" }]
    expect(leftovers({ rows, members: inside(30), runs })).toEqual([])
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

// macOS's `ps -o lstart` of local time `at`, as the listing gives it under LC_ALL=C.
const lstart = (at: number): string => {
  const date = new Date(at)
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]
  const month = date.toLocaleString("en-US", { month: "short" })
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
  return `${day} ${month} ${String(date.getDate()).padStart(2)} ${time} ${date.getFullYear()}`
}

describe("macOS's clock", () => {
  // A second on the wall clock, and processes started in it as the listing shows them.
  const second = new Date(2026, 10, 23, 15, 20, 1).getTime()
  const at = (pid: number, parent: number, ms: number): Listed => ({
    ...row(pid, parent, 0),
    started: lstart(ms),
  })

  it("is the scope's start to the microsecond, where it is the listed process's", () => {
    const listed = at(30, 1, second)
    expect(wallClock.start(listed, { pid: 30, startedMs: second + 359.651 })).toBe(second + 359.651)
    // The listing's own second where the scope gives none.
    expect(wallClock.start(listed)).toBe(second)
    expect(wallClock.start(listed, { pid: 30 })).toBe(second)
  })

  it("is the scope's start whatever zone the listing read it in, as after a trip", () => {
    const startedMs = second + 359.651
    for (const moved of [60, -60, 30, 345, -570].map((minutes) => minutes * 60_000))
      expect(wallClock.start(at(30, 1, second + moved), { pid: 30, startedMs })).toBe(startedMs)
  })

  it("is unknown where the scope and the listing tell of two processes, a pid taken between", () => {
    expect(
      wallClock.start(at(30, 1, second), { pid: 30, startedMs: second + 2_100 }),
    ).toBeUndefined()
  })

  it("counts what the person started in the second the agent started as theirs", () => {
    // In the same second: the person's server at .100, the agent at .400, its server at .700.
    const rows = [
      at(10, 5, second - 60_000),
      at(20, 10, second),
      at(30, 1, second),
      at(31, 1, second),
    ]
    const members = [
      { pid: 10, startedMs: second - 60_000 },
      { pid: 20, startedMs: second + 400 },
      { pid: 30, startedMs: second + 100 },
      { pid: 31, startedMs: second + 700 },
    ]
    const since = runStart(rows, 20, wallClock, members)
    expect(since).toBe(second + 400)
    const found = leftovers({
      rows,
      members,
      runs: [{ since: since!, until: second + 900 }],
      shell: 10,
      clock: wallClock,
    })
    expect(pids(found)).toEqual([31])
  })

  it("is the clock of macOS's runs, Linux's ticks elsewhere", () => {
    expect(runClock("darwin")).toBe(wallClock)
    expect(runClock("linux")).toBe(tickClock)
    const before = Date.now()
    expect(wallClock.now()).toBeGreaterThanOrEqual(before)
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

describe("reading a scope", () => {
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
        () => Promise.resolve(inside(1)),
      ),
    ).toBe(undefined)
    expect(
      await readScope(
        () => Promise.resolve(rows),
        () => Promise.resolve(inside(1)),
      ),
    ).toEqual({
      rows,
      members: inside(1),
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
