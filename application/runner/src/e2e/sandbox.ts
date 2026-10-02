import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, join } from "node:path"

/**
 * Where an end-to-end test runs its harnesses: a throwaway home and project, and an
 * environment made only of what the sandbox sets, never the developer's. Nothing in it
 * can reach the developer's real configuration, login or keyring.
 */
export type Sandbox = {
  readonly root: string
  /** The throwaway HOME, which also holds the XDG folders. */
  readonly home: string
  /** The project folder the agents run in. */
  readonly project: string
  /**
   * The environment every sandboxed process gets: HOME, XDG folders, a PATH of the pinned
   * harnesses and system tools, a dead D-Bus address so no keyring is reachable, the fake
   * model as HTTP(S)_PROXY with loopback exempt (Node's fetch included), and npm's
   * prefix inside the sandbox so a harness that updates itself can't touch a global
   * install.
   */
  readonly env: Readonly<Record<string, string>>
  /**
   * When the sandbox was made, in clock ticks since boot, as `/proc/<pid>/stat` gives a
   * process's start: every process of the sandbox started at or after it.
   */
  readonly started: number
}

export type SandboxOptions = {
  /** The fake model's proxy address. */
  readonly proxy: string
  /** The folders holding the pinned harnesses' programs, first on PATH. */
  readonly bins: readonly string[]
}

/**
 * Makes a sandbox under the system's temporary folder; the caller removes `root`. Node
 * reaches PATH through a folder of its own, as the one it is installed in may hold global
 * installs of the very harnesses under test.
 */
export const createSandbox = (options: SandboxOptions): Sandbox => {
  const started = sinceBoot()
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-e2e-")))
  const folder = (...parts: string[]) => {
    const path = join(root, ...parts)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return path
  }
  const home = folder("home")
  const project = folder("project")
  const runtime = folder("run")
  const node = folder("node")
  symlinkSync(process.execPath, join(node, basename(process.execPath)))
  const proxy = options.proxy
  const loopback = "127.0.0.1,localhost"
  const env: Record<string, string> = {
    HOME: home,
    USER: "novadeck",
    LOGNAME: "novadeck",
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    PATH: [...options.bins, node, "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: folder("tmp"),
    XDG_CONFIG_HOME: folder("home", ".config"),
    XDG_DATA_HOME: folder("home", ".local", "share"),
    XDG_STATE_HOME: folder("home", ".local", "state"),
    XDG_CACHE_HOME: folder("home", ".cache"),
    XDG_RUNTIME_DIR: runtime,
    // A bus that isn't there, so no keyring or secret service answers.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, "no-bus")}`,
    NPM_CONFIG_PREFIX: folder("npm"),
    // Upper and lower case, as programs read one or the other.
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
