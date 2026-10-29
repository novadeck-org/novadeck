import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, join } from "node:path"

import { windowsEnvironment } from "./sandbox/windows.js"

export { gitBash } from "./sandbox/windows.js"

/**
 * Where a test or benchmark runs real shells and programs: a throwaway home and project,
 * and an environment made only of what the sandbox sets, never the developer's. Nothing in
 * it can reach the developer's real configuration, login or keyring, with a gap on each of
 * Windows and macOS, where a store is the user's whatever the environment says: on macOS,
 * the login Keychain and the user's defaults; on Windows, the registry. A `cmd /k` or
 * `cmd /c` without `/d` runs the developer's `HKCU\Software\Microsoft\Command Processor\AutoRun`
 * (clink, doskey macros, a `cd`), so a developer with one set may see a test fail that CI,
 * which has none, passes. A program that keeps its login in one of those stores needs a
 * guard of the caller's own.
 */
export type Sandbox = {
  readonly root: string
  /** The throwaway HOME, which also holds the XDG folders. */
  readonly home: string
  /** The project folder the programs run in. */
  readonly project: string
  /**
   * The environment every sandboxed process gets: HOME, XDG folders, a PATH of the
   * programs under test and system tools, a dead D-Bus address so no secret service
   * answers, the proxy, when given, as HTTP(S)_PROXY with loopback exempt (Node's fetch
   * included), and npm's prefix inside the sandbox so a program that updates itself can't
   * touch a global install. On Windows also the user's folders, which programs there find
   * their home and configuration by (USERPROFILE, APPDATA, LOCALAPPDATA, TEMP), all inside
   * the sandbox, and the system's own variables, which its programs need to start.
   */
  readonly env: Readonly<Record<string, string>>
  /**
   * When the sandbox was made: every process of the sandbox started at or after it. On
   * Linux in clock ticks since boot, as `/proc/<pid>/stat` gives a process's start; on
   * Windows and macOS in milliseconds since the epoch, as a process's creation time and
   * `ps`'s start convert to.
   */
  readonly started: number
}

export type SandboxOptions = {
  /**
   * The sandbox folder's name, before its random part, as `app-e2e-`. One with a space,
   * as a profile folder like `C:\Users\Ada Lovelace` has, names the home with one too.
   */
  readonly prefix: string
  /** The folders holding the programs under test, first on PATH. */
  readonly bins: readonly string[]
  /** The proxy every program is sent through, loopback exempt; none where unset. */
  readonly proxy?: string
  /**
   * Programs a tool's folder on PATH must not hold besides Node's, as those under test:
   * named without their extension.
   */
  readonly forbidden?: readonly string[]
  /** The user name programs see; `sandbox` where unset. */
  readonly user?: string
}

const windows = process.platform === "win32"

/** The proxy variables, upper and lower case, as programs read one or the other. */
const proxied = (proxy: string): Record<string, string> => {
  const loopback = "127.0.0.1,localhost"
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: loopback,
    no_proxy: loopback,
    // Node's own fetch takes the proxy only when told to.
    NODE_USE_ENV_PROXY: "1",
  }
}

/**
 * Makes a sandbox under the system's temporary folder; the caller removes `root`. Node
 * reaches PATH through a folder of its own, as the one it is installed in may hold global
 * installs of the very programs under test.
 */
export const createSandbox = (options: SandboxOptions): Sandbox => {
  const started = process.platform === "linux" ? sinceBoot() : Date.now()
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), options.prefix)))
  const folder = (...parts: string[]) => {
    const path = join(root, ...parts)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return path
  }
  const user = options.user ?? "sandbox"
  const home = folder("home")
  const project = folder("project")
  const runtime = folder("run")
  const node = folder("node")
  symlinkSync(process.execPath, join(node, basename(process.execPath)))
  const system = windows
    ? windowsEnvironment(home, user, options.forbidden ?? [], folder)
    : undefined
  const env: Record<string, string> = {
    ...system?.env,
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: windows ? (system?.env.ComSpec ?? "cmd.exe") : "/bin/bash",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    PATH: [...options.bins, node, ...(system?.path ?? ["/usr/bin", "/bin"])].join(delimiter),
    TMPDIR: folder("tmp"),
    XDG_CONFIG_HOME: folder("home", ".config"),
    XDG_DATA_HOME: folder("home", ".local", "share"),
    XDG_STATE_HOME: folder("home", ".local", "state"),
    XDG_CACHE_HOME: folder("home", ".cache"),
    XDG_RUNTIME_DIR: runtime,
    // A bus that isn't there, so no keyring or secret service answers.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, "no-bus")}`,
    NPM_CONFIG_PREFIX: folder("npm"),
    ...(options.proxy && proxied(options.proxy)),
  }
  return { root, home, project, env, started }
}

// The clock ticks a second that /proc counts processes' start in.
let ticks: number | undefined
const hertz = (): number => {
  try {
    ticks ??= Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) || 100
  } catch {
    ticks = 100
  }
  return ticks
}

// Clock ticks since boot now, from /proc/uptime; 0 where there is none.
const sinceBoot = (): number => {
  try {
    const seconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0])
    return Math.floor(seconds * hertz())
  } catch {
    return 0
  }
}
