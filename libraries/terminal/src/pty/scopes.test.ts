import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { nativeStandIn } from "../testing.js"
import { spawnPty, type PtyExit } from "./pty.js"
import {
  killsSince,
  scopePrefix,
  startScope,
  userBus,
  userScopes,
  UserScopes,
  type RunTool,
} from "./scopes.js"

// systemd's tools as a table plays them: each run is recorded, and answers what its tool's
// entry says, or fails as where that tool isn't there.
const tools = (answers: { busctl?: () => Promise<string>; journalctl?: () => Promise<string> }) => {
  const runs: { file: string; args: readonly string[] }[] = []
  const run: RunTool = (file, args) => {
    runs.push({ file, args })
    const answer = answers[file as keyof typeof answers]
    if (!answer)
      return Promise.reject(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }))
    return answer()
  }
  return { runs, run }
}

const reachable = () => Promise.resolve("")
const unreachable = () =>
  Promise.reject(new Error("Failed to connect to bus: No such file or directory"))

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a scope's name", () => {
  it("follows the app's own scope, so each terminal shows under the app", () => {
    const cgroup =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-dev.mzpk.novadeck-3463912.scope\n"
    expect(scopePrefix(cgroup)).toBe("app-dev.mzpk.novadeck")
  })

  it("keeps a launcher's part of the name", () => {
    expect(scopePrefix("0::/user.slice/app.slice/app-gnome-dev.mzpk.novadeck-77.scope")).toBe(
      "app-gnome-dev.mzpk.novadeck",
    )
  })

  it("is the app's again for Novadeck started from one of its own terminals", () => {
    expect(scopePrefix("0::/user.slice/app.slice/app-dev.mzpk.novadeck-term4242.scope")).toBe(
      "app-dev.mzpk.novadeck",
    )
  })

  it("is Novadeck's own where the app runs in no app scope", () => {
    expect(scopePrefix("0::/user.slice/user-1000.slice/session-2.scope")).toBe("app-novadeck")
    expect(scopePrefix("0::/system.slice/novadeck.service")).toBe("app-novadeck")
    expect(scopePrefix("")).toBe("app-novadeck")
  })
})

describe("starting a terminal's scope", () => {
  it("moves the shell's process into a transient scope that keeps it on a program's OOM kill", () => {
    expect(startScope("app-novadeck-term42.scope", 42)).toEqual([
      "--user",
      "--quiet",
      "--timeout=5",
      "call",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      "app-novadeck-term42.scope",
      "fail",
      "4",
      "PIDs",
      "au",
      "1",
      "42",
      "CollectMode",
      "s",
      "inactive-or-failed",
      "OOMPolicy",
      "s",
      "continue",
      "Description",
      "s",
      "Novadeck terminal",
      "0",
    ])
  })

  it("asks the user's service manager for each shell's own scope", async () => {
    const { runs, run } = tools({ busctl: reachable })
    const scopes = new UserScopes("app-novadeck", run)
    scopes.contain(42)
    scopes.contain(43)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(runs.map(({ file, args }) => [file, args[9], args[15]])).toEqual([
      ["busctl", "app-novadeck-term42.scope", "42"],
      ["busctl", "app-novadeck-term43.scope", "43"],
    ])
  })
})

describe("without systemd", () => {
  it("leaves every later shell in the app's scope once the first can't be moved", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { runs, run } = tools({ busctl: unreachable })
    const scopes = new UserScopes("app-novadeck", run, 0)
    const first = scopes.contain(42)
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(await first.cause("SIGKILL")).toBeUndefined()
    expect(scopes.contain(43).cause("SIGKILL")).toBeUndefined()
    // No second try, and no journal looked at.
    expect(runs.map(({ file }) => file)).toEqual(["busctl"])
    expect(error).toHaveBeenCalledOnce()
  })

  it("says nothing where systemd's tools aren't there", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { run } = tools({})
    const scopes = new UserScopes("app-novadeck", run, 0)
    expect(await scopes.contain(42).cause("SIGKILL")).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })

  it("keeps moving shells after a first one that had exited, or whose name was taken", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const failures = [
      "Call failed: Failed to set unit properties: No such process",
      // systemd 255's words for a name an earlier program's scope still holds, and older ones'.
      "Call failed: Unit app-novadeck-term42.scope was already loaded or has a fragment file.",
      "Call failed: Unit app-novadeck-term42.scope already exists.",
      "Call failed: Connection timed out",
    ]
    for (const failure of failures) {
      let first = true
      const { runs, run } = tools({
        busctl: () => {
          if (!first) return reachable()
          first = false
          return Promise.reject(new Error(`Command failed: busctl\n${failure}`))
        },
      })
      const scopes = new UserScopes("app-novadeck", run, 0)
      // eslint-disable-next-line no-await-in-loop -- Each failure is checked in turn.
      expect(await scopes.contain(42).cause("SIGKILL")).toBeUndefined()
      scopes.contain(43)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await vi.waitFor(() => expect(runs).toHaveLength(2))
    }
    expect(error).not.toHaveBeenCalled()
  })

  it("keeps moving shells after a first move that ran out of time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    let first = true
    const { runs, run } = tools({
      busctl: () => {
        if (!first) return reachable()
        first = false
        return Promise.reject(Object.assign(new Error("Command failed: busctl"), { killed: true }))
      },
    })
    const scopes = new UserScopes("app-novadeck", run, 0)
    expect(await scopes.contain(42).cause("SIGKILL")).toBeUndefined()
    scopes.contain(43)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(error).not.toHaveBeenCalled()
  })

  it("says nothing where the session bus has no systemd on it, as with elogind", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { run } = tools({
      busctl: () =>
        Promise.reject(
          new Error(
            "Command failed: busctl\nCall failed: The name org.freedesktop.systemd1 was not provided by any .service files",
          ),
        ),
    })
    const scopes = new UserScopes("app-novadeck", run, 0)
    expect(await scopes.contain(42).cause("SIGKILL")).toBeUndefined()
    expect(scopes.contain(43).cause("SIGKILL")).toBeUndefined()
    expect(error).not.toHaveBeenCalled()
  })

  it("keeps moving shells after one fails, once others were moved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    let fail = false
    const { runs, run } = tools({ busctl: () => (fail ? unreachable() : reachable()) })
    const scopes = new UserScopes("app-novadeck", run, 0)
    scopes.contain(42)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    fail = true
    scopes.contain(43)
    fail = false
    scopes.contain(44)
    await vi.waitFor(() => expect(runs).toHaveLength(3))
    expect(console.error).not.toHaveBeenCalled()
  })

  it("has no scopes off Linux, or without a user bus to ask", () => {
    const env = { DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-1" }
    expect(userScopes("darwin", env)).toBeUndefined()
    expect(userScopes("win32", env)).toBeUndefined()
    expect(userScopes("linux", {})).toBeUndefined()
    // A runtime directory with no bus in it, as on a CI machine.
    const empty = mkdtempSync(join(tmpdir(), "novadeck-runtime-"))
    try {
      expect(userScopes("linux", { XDG_RUNTIME_DIR: empty })).toBeUndefined()
      writeFileSync(join(empty, "bus"), "")
      expect(userScopes("linux", { XDG_RUNTIME_DIR: empty })).toBeInstanceOf(UserScopes)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
    expect(userScopes("linux", env)).toBeInstanceOf(UserScopes)
  })

  it("finds the user bus as systemd's tools do", () => {
    expect(userBus({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" })).toEqual({
      path: "/run/user/1000/bus",
    })
    expect(
      userBus({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus,guid=1",
        XDG_RUNTIME_DIR: "/x",
      }),
    ).toEqual({ path: "/run/user/1000/bus" })
    expect(userBus({ DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-1" })).toEqual({})
    expect(userBus({ XDG_RUNTIME_DIR: "/run/user/1000" })).toEqual({ path: "/run/user/1000/bus" })
    expect(userBus({})).toBeUndefined()
  })
})

describe("why a scoped shell ended", () => {
  it("is out of memory where systemd says it killed in the shell's scope", async () => {
    const { runs, run } = tools({
      busctl: reachable,
      journalctl: () =>
        Promise.resolve(
          "app-novadeck-term42.scope: A process of this unit has been killed by the OOM killer.\n",
        ),
    })
    const scopes = new UserScopes("app-novadeck", run, 0)
    const now = Date.now()
    expect(await scopes.contain(42).cause("SIGKILL")).toBe("out-of-memory")
    const [, journal] = runs
    expect(journal?.file).toBe("journalctl")
    const since = Number(/--since=@(\d+)/.exec(journal?.args.join(" ") ?? "")?.[1])
    expect(since).toBeLessThanOrEqual(Math.floor(now / 1000) - 4)
    expect(since).toBeGreaterThanOrEqual(Math.floor(now / 1000) - 6)
  })

  it("is given up on where the journal takes too long, so the exit isn't held", async () => {
    vi.useFakeTimers()
    try {
      const { run } = tools({ busctl: reachable, journalctl: () => new Promise<string>(() => {}) })
      const cause = new UserScopes("p", run, 250).contain(42).cause("SIGKILL")
      let settled: unknown = "pending"
      void cause?.then((found) => (settled = found))
      await vi.advanceTimersByTimeAsync(2_249)
      expect(settled).toBe("pending")
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("is unknown where the journal tells of no kill, or can't be read", async () => {
    const quiet = tools({ busctl: reachable, journalctl: () => Promise.resolve("\n") })
    expect(await new UserScopes("p", quiet.run, 0).contain(42).cause("SIGKILL")).toBeUndefined()
    const unreadable = tools({
      busctl: reachable,
      journalctl: () => Promise.reject(new Error("No journal files")),
    })
    expect(
      await new UserScopes("p", unreadable.run, 0).contain(42).cause("SIGKILL"),
    ).toBeUndefined()
  })

  it("isn't looked up for an exit that no OOM kill makes", async () => {
    const { runs, run } = tools({ busctl: reachable, journalctl: reachable })
    const scope = new UserScopes("p", run, 0).contain(42)
    expect(scope.cause(null)).toBeUndefined()
    expect(scope.cause("SIGTERM")).toBeUndefined()
    expect(scope.cause("SIGHUP")).toBeUndefined()
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs.map(({ file }) => file)).toEqual(["busctl"])
  })

  it("is searched for both the kernel's OOM kills and systemd-oomd's", () => {
    expect(killsSince("app-novadeck-term42.scope", 1_700_000_000_999)).toEqual([
      "--user",
      "--quiet",
      "--output=cat",
      "--unit=app-novadeck-term42.scope",
      "--since=@1700000000",
      "MESSAGE_ID=fe6faa94e7774663a0da52717891d8ef",
      "MESSAGE_ID=d989611b15e44c9dbf31e3c81256e4ed",
    ])
  })
})

describe("a pty in a scope", () => {
  const scoped = (cause: "out-of-memory" | undefined) => {
    const contained: number[] = []
    const asked: (string | null)[] = []
    const scopes = {
      contain: (pid: number) => {
        contained.push(pid)
        return {
          cause: (signal: string | null) => {
            asked.push(signal)
            return signal === "SIGKILL" ? Promise.resolve(cause) : undefined
          },
        }
      },
    }
    return { contained, asked, scopes }
  }
  const start = (
    scopes: ReturnType<typeof scoped>["scopes"],
    stand = nativeStandIn({ pid: 4242 }),
  ) => {
    const pty = spawnPty({
      file: "sh",
      args: [],
      cwd: "/",
      env: {},
      cols: 80,
      rows: 24,
      platform: "linux",
      native: () => stand.native,
      scopes,
    })
    const exits: PtyExit[] = []
    pty.onExit((exit) => exits.push(exit))
    return { pty, stand, exits }
  }

  it("is taken into its scope as it starts", () => {
    const { contained, scopes } = scoped(undefined)
    start(scopes)
    expect(contained).toEqual([4242])
  })

  it("ends killed for memory where its scope says so", async () => {
    const { scopes } = scoped("out-of-memory")
    const { stand, exits } = start(scopes)
    stand.exit(undefined, 9)
    await vi.waitFor(() => expect(exits).toHaveLength(1))
    expect(exits).toEqual([{ code: null, signal: "SIGKILL", cause: "out-of-memory" }])
  })

  it("reports any other exit at once, with no cause", () => {
    const { scopes } = scoped("out-of-memory")
    const { stand, exits } = start(scopes)
    stand.exit(1)
    expect(exits).toEqual([{ code: 1, signal: null }])
  })

  it("ends killed, with no cause, where its scope finds none", async () => {
    const { scopes } = scoped(undefined)
    const { stand, exits } = start(scopes)
    stand.exit(undefined, 9)
    await vi.waitFor(() => expect(exits).toHaveLength(1))
    expect(exits).toEqual([{ code: null, signal: "SIGKILL" }])
  })

  it("takes no input, size or signal while its exit waits for its cause", async () => {
    let answer: (cause: "out-of-memory" | undefined) => void = () => {}
    const scopes = {
      contain: () => ({
        cause: () => new Promise<"out-of-memory" | undefined>((resolve) => (answer = resolve)),
      }),
    }
    const { pty, stand, exits } = start(scopes)
    stand.exit(undefined, 9)
    pty.write("ls\r")
    pty.resize(100, 30)
    pty.pause()
    pty.resume()
    const ended = pty.end({
      graceMs: 0,
      treeGraceMs: 0,
      trees: { read: async () => undefined, end: async () => {} },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stand.calls).toEqual([])
    expect(exits).toEqual([])
    answer("out-of-memory")
    await ended
    expect(exits).toEqual([{ code: null, signal: "SIGKILL", cause: "out-of-memory" }])
    expect(stand.calls).toEqual([])
  })

  it("isn't asked why once the app itself ends it", async () => {
    const { asked, scopes } = scoped("out-of-memory")
    const { pty, stand, exits } = start(scopes)
    const ended = pty.end({
      graceMs: 10_000,
      treeGraceMs: 0,
      trees: { read: async () => undefined, end: async () => {} },
    })
    await vi.waitFor(() => expect(stand.calls).toContain("kill"))
    stand.exit(undefined, 9)
    await ended
    expect(exits).toEqual([{ code: null, signal: "SIGKILL" }])
    expect(asked).toEqual([])
  })
})
