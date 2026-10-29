import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { posix } from "node:path"
import { promisify } from "node:util"

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
}

/** Where each pty's program is kept apart from the app's own processes. */
export type Scopes = { contain(pid: number): Scope }

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
 * `app[-<launcher>]-<id>-<random>.scope`, so desktops count it the app's. An app started
 * from a Novadeck terminal names its terminals after the same app.
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
 * The user's systemd manager's call that starts `unit`, a transient scope, with process
 * `pid` moved into it. Its `OOMPolicy` is `continue`: what the kernel kills for memory is
 * the one program, as outside a scope, not the shell and the agent that started it.
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
  "4",
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

/** A program left in the app's scope, as where systemd can't give it one. */
const unscoped: Scope = { cause: () => undefined }

/**
 * Linux's scopes: each pty's program goes into a transient systemd scope of its own as it
 * starts, through the user's service manager, so the kernel or systemd-oomd killing one
 * for memory takes only that terminal, not the app and the others. An app scope's
 * default `OOMPolicy=stop` otherwise ends all of it on one kill. Programs it starts
 * meanwhile stay behind, as the move follows the start by some milliseconds. Where the
 * first move fails, as without systemd, the rest stay in the app's scope too, as before;
 * a move that fails for its program alone, as one that exited at once, changes nothing.
 */
export class UserScopes implements Scopes {
  private state: "unknown" | "works" | "off" = "unknown"

  constructor(
    private readonly prefix: string,
    private readonly run: RunTool = runTool,
    private readonly delayMs = journalMs,
  ) {}

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
    return {
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
