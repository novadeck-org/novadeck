import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { posix } from "node:path"
import { promisify } from "node:util"

import type { Followed, Listed } from "./descendants.js"

/** Why a pty's program ended, where its platform says: it was killed for memory. */
export type ExitCause = "out-of-memory"

/** Runs `file` with `args` for its output; rejects where it can't run or fails. */
export type RunTool = (file: string, args: readonly string[]) => Promise<string>

/** A program's own scope, asked for as it started. */
export type Scope = {
  /**
   * Why the program ended by `signal`, where it may have been killed for memory: by
   * SIGKILL, as both the kernel and systemd-oomd kill. Undefined where nothing need be
   * looked up, so the exit is reported at once.
   */
  cause(signal: string | null): Promise<ExitCause | undefined> | undefined
  /**
   * Sets the scope's CPU weight, once it exists, calls in order; it never rejects, as a scope
   * that has ended or a systemd that is slow leaves the weight as it was. Nothing where the
   * program has no scope.
   */
  weigh(weight: number): Promise<void>
  /**
   * The pids in the scope now, as its cgroup lists them, however each got there: a program
   * started detached (`setsid`, `nohup`, a daemon that forked twice) stays in the scope of
   * the terminal it was started in, though it has left the shell's tree. Undefined where it
   * can't be told, as with no scope; it never rejects.
   */
  members(): Promise<readonly number[] | undefined>
  /**
   * Its program has exited: a scope left empty is stopped. A scope whose program was moved in
   * as it died stays active with nothing in it for ever, as systemd collects a scope only once
   * its cgroup empties, and this one was never seen full. One that still holds processes is
   * left for systemd to collect once they end. It never rejects.
   */
  exited(): Promise<void>
  /**
   * Whether the program reached its scope, once that is settled, where it gets there only
   * some milliseconds after it starts and its shell can't see that for itself, as with a
   * Windows job (`windowsJobs`): the shell's startup command waits for it.
   */
  readonly held?: Promise<boolean>
  /**
   * The processes in the scope now, as a listing shows them, where the scope can say so
   * itself, as a Windows job does, which no `Listing` can see. Undefined where it can't be
   * told; it never rejects.
   */
  listed?(): Promise<readonly Listed[] | undefined>
  /**
   * Ends each of `ones` still running as the process it was, by its pid and start, where the
   * scope can, as Windows has no signal to send first. It never rejects.
   */
  end?(ones: readonly Followed[]): Promise<void>
  /**
   * The terminal is gone, and nothing reads its scope again: what still runs in it runs on,
   * in no scope of Novadeck's. Where letting go would end what runs there, as stopping a
   * systemd scope would, there is none.
   */
  done?(): void
}

/** Where each pty's program is kept apart from the app's own processes. */
export type Scopes = {
  contain(pid: number): Scope
  /** Whether a program started now is on its way to a scope of its own. */
  active(): boolean
}

const runTool: RunTool = async (file, args) =>
  (await promisify(execFile)(file, [...args], { timeout: 5_000 })).stdout

// The journal's ids for systemd's "A process of this unit has been killed by the OOM
// killer" and "systemd-oomd killed some process(es) in this unit".
const killedForMemory = ["fe6faa94e7774663a0da52717891d8ef", "d989611b15e44c9dbf31e3c81256e4ed"]

/** How long systemd's word of a kill may take to reach the journal. */
const journalMs = 250
/** How long before an exit a kill counts as its cause. */
const causeWindowMs = 5_000
/** How long an exit waits for its cause at most, however slow systemd's tools are. */
const causeMs = 2_000

/**
 * Whether the move failed for this program alone, or for now, which says nothing of
 * systemd: it had already exited ("No such process"), its pid's name was taken by a scope
 * an earlier program with that pid left running, or systemd was too slow to answer, as
 * while memory runs short.
 */
const failedForProgram = (error: unknown): boolean =>
  (error as { killed?: boolean }).killed === true ||
  /No such process|already exists|already loaded|timed? ?out/i.test(String(error))

/**
 * Whether the move failed for want of systemd, which needs no word: its tools aren't
 * there, or the session bus has no service manager on it, as with elogind.
 */
const noSystemd = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  /org\.freedesktop\.systemd1 was not provided|ServiceUnknown/i.test(String(error))

/**
 * The name's start for a program's scope: the app's own, from this process's cgroup, as
 * `app-dev.mzpk.novadeck-1234.scope` gives `app-dev.mzpk.novadeck`; `app-novadeck` where
 * it runs in no app scope. Each scope is then `<start>-term<pid>.scope`, the XDG shape
 * `app[-<launcher>]-<id>-<random>.scope`, so desktops count it the app's. Novadeck started
 * from one of its own terminals names its terminals after the same app.
 */
export const scopePrefix = (cgroup: string): string => {
  const leaf = cgroup
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.split("/")
    .at(-1)
  return /^(app-.+)-[^-]+\.scope$/.exec(leaf ?? "")?.[1] ?? "app-novadeck"
}

/**
 * A terminal's share of the CPU beside the app's own scope, whose weight is systemd's
 * default of 100. Agents' builds and test runs in many terminals at once otherwise
 * starve the app's window: inside the desktop's `app.slice` every thread weighs the
 * same, so the window waited for a CPU longer than it ran, and every hover, key and
 * scroll lagged. At a tenth, the window comes first while the CPU is short, and the
 * terminals still have all of it while the window is idle.
 */
export const terminalCpuWeight = 10

/** The weight of the terminal the person is using: the app's own, systemd's default. */
export const activeCpuWeight = 100

/**
 * The user's systemd manager's call that sets `unit`'s CPU weight now, without keeping it
 * past a reboot: the scope's own weight, so it covers everything the terminal's program
 * started, as its tests and scripts.
 */
export const setScopeWeight = (unit: string, weight: number): readonly string[] => [
  "--user",
  "--quiet",
  "--timeout=5",
  "call",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "SetUnitProperties",
  "sba(sv)",
  unit,
  "true",
  "1",
  "CPUWeight",
  "t",
  String(weight),
]

/**
 * The user's systemd manager's call that starts `unit`, a transient scope, with process
 * `pid` moved into it. Its `OOMPolicy` is `continue`: what the kernel kills for memory is
 * the one program, as outside a scope, not the shell and the agent that started it. Its
 * `CPUWeight` puts the app's window ahead of the terminal's programs while the CPU is
 * short; where systemd has no CPU controller to give, it is left unset.
 */
export const startScope = (unit: string, pid: number): readonly string[] => [
  "--user",
  "--quiet",
  "--timeout=5",
  "call",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "StartTransientUnit",
  "ssa(sv)a(sa(sv))",
  unit,
  "fail",
  "5",
  "PIDs",
  "au",
  "1",
  String(pid),
  "CollectMode",
  "s",
  "inactive-or-failed",
  "OOMPolicy",
  "s",
  "continue",
  "CPUWeight",
  "t",
  String(terminalCpuWeight),
  "Description",
  "s",
  "Novadeck terminal",
  "0",
]

/** The journal's search for `unit` killed for memory since `since` (ms since the epoch). */
export const killsSince = (unit: string, since: number): readonly string[] => [
  "--user",
  "--quiet",
  "--output=cat",
  `--unit=${unit}`,
  `--since=@${Math.floor(since / 1000)}`,
  ...killedForMemory.map((id) => `MESSAGE_ID=${id}`),
]

/**
 * `unit`'s object path on systemd's bus: each character but a letter or a digit (and a
 * leading digit) as `_` and its two hex digits, as systemd's `bus_label_escape` writes it.
 */
export const unitPath = (unit: string): string =>
  `/org/freedesktop/systemd1/unit/${[...unit]
    .map((char, at) =>
      /[A-Za-z]/.test(char) || (at > 0 && /\d/.test(char))
        ? char
        : `_${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
    )
    .join("")}`

/** The user's systemd manager's call that reads scope `unit`'s cgroup, as `s "<path>"`. */
export const scopeGroup = (unit: string): readonly string[] => [
  "--user",
  "--timeout=5",
  "get-property",
  "org.freedesktop.systemd1",
  unitPath(unit),
  "org.freedesktop.systemd1.Scope",
  "ControlGroup",
]

/** The user's systemd manager's call that stops `unit`. */
export const stopScope = (unit: string): readonly string[] => [
  "--user",
  "--quiet",
  "--timeout=5",
  "call",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "StopUnit",
  "ss",
  unit,
  "replace",
]

/** The path `get-property` answers with; undefined for none, as for a unit that has gone. */
export const parseGroup = (answer: string): string | undefined => {
  const path = /^s\s+"(.*)"\s*$/.exec(answer.trim())?.[1]
  return path?.startsWith("/") ? path : undefined
}

/** Reads a cgroup's file, by its path under the cgroup root; rejects where it can't. */
export type ReadGroup = (path: string) => Promise<string>

// Where the unified cgroup hierarchy is mounted: at the root on cgroup v2 alone, under
// `unified` on a hybrid one.
const groupRoot = (): string =>
  existsSync("/sys/fs/cgroup/cgroup.controllers") ? "/sys/fs/cgroup" : "/sys/fs/cgroup/unified"

const readGroup: ReadGroup = (path) => readFile(posix.join(groupRoot(), path), "utf8")

/** The pids a `cgroup.procs` lists. */
export const parseProcs = (procs: string): number[] =>
  procs
    .split("\n")
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)

/** A program left in the app's scope, as where systemd can't give it one. */
const unscoped: Scope = {
  cause: () => undefined,
  weigh: () => Promise.resolve(),
  members: () => Promise.resolve(undefined),
  exited: () => Promise.resolve(),
}

/**
 * Linux's scopes: each pty's program goes into a transient systemd scope of its own as it
 * starts, through the user's service manager, so the kernel or systemd-oomd killing one
 * for memory takes only that terminal, not the app and the others. An app scope's
 * default `OOMPolicy=stop` otherwise ends all of it on one kill. Programs it starts
 * meanwhile stay behind, as the move follows the start by some milliseconds, which is why
 * a shell's startup command waits for it (see the shell integration). Where the first move
 * fails, as without systemd, the rest stay in the app's scope too, as before;
 * a move that fails for its program alone, as one that exited at once, changes nothing.
 */
export class UserScopes implements Scopes {
  private state: "unknown" | "works" | "off" = "unknown"

  constructor(
    private readonly prefix: string,
    private readonly run: RunTool = runTool,
    private readonly delayMs = journalMs,
    private readonly read: ReadGroup = readGroup,
  ) {}

  active(): boolean {
    return this.state !== "off"
  }

  contain(pid: number): Scope {
    if (this.state === "off") return unscoped
    const unit = `${this.prefix}-term${pid}.scope`
    const started = this.run("busctl", startScope(unit, pid)).then(
      () => {
        this.state = "works"
        return true
      },
      (error: unknown) => {
        if (this.state !== "unknown" || failedForProgram(error)) return false
        this.state = "off"
        // Said once, unless there's no systemd to ask.
        if (!noSystemd(error))
          console.error("Novadeck terminals stay in the app's scope:", String(error).trim())
        return false
      },
    )
    // Weights are set one after another, so the last asked is the last set.
    let weighed: Promise<void> = started.then(() => undefined)
    // The scope's cgroup, asked once it is known; asked again after an answer that named none.
    let group: Promise<string | undefined> | undefined
    const groupOf = (): Promise<string | undefined> => {
      group ??= this.run("busctl", scopeGroup(unit))
        .then(parseGroup)
        .catch(() => undefined)
      const asked = group
      void asked.then((path) => {
        if (path === undefined && group === asked) group = undefined
      })
      return asked
    }
    return {
      members: async () => {
        if (!(await started)) return undefined
        const path = await groupOf()
        if (path === undefined) return undefined
        return this.read(posix.join(path, "cgroup.procs")).then(parseProcs, () => undefined)
      },
      exited: async () => {
        // Whether it was moved or not: a move whose program was dying may have made the
        // scope and still been refused. Asked again a moment later where systemd named no
        // cgroup yet, as while its start is still under way.
        const moved = await started
        let path = await groupOf()
        if (path === undefined && moved) {
          await new Promise((resolve) => setTimeout(resolve, this.delayMs * 2))
          path = await groupOf()
        }
        if (path === undefined) return
        // Only a cgroup read and found empty: one that can't be read, as where the cgroups
        // here aren't systemd's, may hold anything.
        const procs = await this.read(posix.join(path, "cgroup.procs")).catch(() => undefined)
        if (procs === undefined || parseProcs(procs).length > 0) return
        await this.run("busctl", stopScope(unit)).catch(() => undefined)
      },
      weigh: (weight) => {
        weighed = weighed
          .then(async () => {
            if (await started) await this.run("busctl", setScopeWeight(unit, weight))
          })
          .catch(() => undefined)
        return weighed
      },
      cause: (signal) => {
        if (signal !== "SIGKILL") return undefined
        const exited = Date.now()
        const found = started
          .then(async (scoped) => {
            if (!scoped) return undefined
            await new Promise((resolve) => setTimeout(resolve, this.delayMs))
            const kills = await this.run("journalctl", killsSince(unit, exited - causeWindowMs))
            return kills.trim() ? ("out-of-memory" as const) : undefined
          })
          .catch(() => undefined)
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, this.delayMs + causeMs, undefined)
        })
        return Promise.race([found, late]).finally(() => clearTimeout(timer))
      },
    }
  }
}

/**
 * The user's bus, as systemd's tools reach it: the session bus's address, or the runtime
 * directory's `bus`; a socket's path where it names one, to tell it's there.
 */
export const userBus = (env: NodeJS.ProcessEnv): { path?: string } | undefined => {
  const address = env.DBUS_SESSION_BUS_ADDRESS
  if (address) {
    const path = /^unix:path=([^,;]+)/.exec(address)?.[1]
    return path ? { path } : {}
  }
  return env.XDG_RUNTIME_DIR ? { path: posix.join(env.XDG_RUNTIME_DIR, "bus") } : undefined
}

/**
 * Scopes for this system's ptys: on Linux, where the user's bus is there, `UserScopes`;
 * elsewhere none, and programs run where the app does.
 */
export const userScopes = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Scopes | undefined => {
  if (platform !== "linux") return undefined
  const bus = userBus(env)
  if (!bus || (bus.path !== undefined && !existsSync(bus.path))) return undefined
  let cgroup = ""
  try {
    cgroup = readFileSync("/proc/self/cgroup", "utf8")
  } catch {
    // Read as no app scope.
  }
  return new UserScopes(scopePrefix(cgroup))
}
