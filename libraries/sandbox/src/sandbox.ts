import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"

/**
 * Where a test or benchmark runs real shells and programs: a throwaway home and project,
 * and an environment made only of what the sandbox sets, never the developer's. Nothing in
 * it can reach the developer's real configuration, login or keyring, with a gap on each of
 * Windows and macOS, where a store is the user's whatever the environment says: on macOS,
 * the login Keychain and the user's defaults; on Windows, the registry. A `cmd /k` or
 * `cmd /c` without `/d` runs the developer's
 * `HKCU\Software\Microsoft\Command Processor\AutoRun` (clink, doskey macros, a `cd`),
 * so a developer with one set may see a test fail that CI, which has none, passes. A
 * program that keeps its login in one of those stores needs a guard of the caller's own.
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

const windows = process.platform === "win32"

// The first folder on the caller's own PATH holding the program, for the system tools a
// sandbox on Windows needs (git, PowerShell 7), never a program under test.
const onPath = (program: string): string | undefined =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .find((folder) => existsSync(join(folder, program)))

// What a program prints, or undefined should it fail.
const asked = (program: string, args: readonly string[]): string | undefined => {
  try {
    return execFileSync(program, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

// Asked once a run (see `toolFolders`).
let git: { readonly found: string; readonly install: string | undefined } | undefined | null
let pwsh: string | undefined | null

/**
 * The git on the caller's PATH: the folder it was found in, and Git for Windows' own
 * install, `<Git>`, three folders above `git --exec-path`'s `<Git>\mingw64\libexec\git-core`
 * where `<Git>\cmd\git.exe` is there. An MSYS2 or Cygwin git (`/usr/lib/git-core`) has
 * none such, its install unknown.
 */
const gitOnPath = () => {
  if (git !== undefined) return git ?? undefined
  const found = onPath("git.exe")
  const core = found && asked(join(found, "git.exe"), ["--exec-path"])
  const install = core && dirname(dirname(dirname(core)))
  git = found
    ? {
        found,
        install: install && existsSync(join(install, "cmd", "git.exe")) ? install : undefined,
      }
    : null
  return git ?? undefined
}

/**
 * Git for Windows' bash, which some programs on Windows run their shell commands in and
 * won't start without: `<Git>\bin\bash.exe` of the install the sandbox's PATH has (see
 * `gitOnPath`). Where that isn't known, it is looked for above the folder the git was
 * found in, whether `<Git>\cmd`, as an install puts on PATH, `<Git>\bin`, or
 * `<Git>\mingw64\bin`, first on PATH under Git's own bash, as CI's steps run.
 */
export const gitBash = (): string | undefined => {
  const found = gitOnPath()
  if (!found) return undefined
  const above = found.install
    ? [found.install]
    : [found.found, dirname(found.found), dirname(dirname(found.found))]
  return above.map((root) => join(root, "bin", "bash.exe")).find((path) => existsSync(path))
}

/**
 * PowerShell 7's own install, `$PSHOME`, which it prints as base64, as a pipe gets the
 * console's code page, which would lose a folder's name past ASCII (`C:\Users\Łukasz`).
 */
const pwshHome = (): string | undefined => {
  if (pwsh !== undefined) return pwsh ?? undefined
  const found = onPath("pwsh.exe")
  const printed =
    found &&
    asked(join(found, "pwsh.exe"), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PSHOME))",
    ])
  const home = printed && Buffer.from(printed, "base64").toString("utf8")
  pwsh = home && existsSync(join(home, "pwsh.exe")) ? home : null
  return pwsh ?? undefined
}

// Programs a folder on the sandbox's PATH must never hold, as a tool's folder may: Node,
// which installs programs globally beside it, and those the caller names (see
// `SandboxOptions.forbidden`).
const programs = (names: readonly string[]): readonly string[] =>
  ["node", "npm", "npx", ...names].flatMap((name) => [`${name}.exe`, `${name}.cmd`])

/**
 * The folder a tool was found in, standing in for its install where that can't be told:
 * said so, and refused where it holds a forbidden program, as a package manager's shims
 * folder (scoop's `shims`, `%LOCALAPPDATA%\Microsoft\WindowsApps`) may.
 */
const standIn = (folder: string, tool: string, forbidden: readonly string[]): string => {
  const held = forbidden.filter((name) => existsSync(join(folder, name)))
  if (held.length > 0)
    throw new Error(
      `The sandbox can't tell where ${tool} is installed, and the folder it was found in, ${folder}, holds ${held.join(", ")}, which the sandbox's PATH must not: put ${tool}'s own install first on PATH.`,
    )
  console.warn(`The sandbox can't tell where ${tool} is installed; it uses ${folder}.`)
  return folder
}

/**
 * The folders of git and PowerShell 7 a sandbox on Windows puts on PATH: each one's own
 * install, as it reports it, not the folder the tests found it in, which may be a package
 * manager's (scoop's `shims`, Chocolatey's `bin`) holding a shim of every global tool, a
 * forbidden program among them. Not the programs alone, linked: Git's `cmd\git.exe` finds
 * the rest of Git by its own path, as `pwsh.exe` its libraries, and a shim its `.shim`.
 * Git's is `<Git>\cmd` (see `gitOnPath`); PowerShell's is `$PSHOME`. Where either can't be
 * told, as for an MSYS2 git, the folder it was found in stands in (see `standIn`), rather
 * than leaving it off PATH for a program to fail on later, unclearly.
 */
const toolFolders = (forbidden: readonly string[]): readonly string[] => {
  const gitFound = gitOnPath()
  const pwshFound = onPath("pwsh.exe")
  return [
    gitFound &&
      (gitFound.install
        ? join(gitFound.install, "cmd")
        : standIn(gitFound.found, "git", forbidden)),
    pwshHome() ?? (pwshFound && standIn(pwshFound, "PowerShell 7", forbidden)),
  ].filter((folder) => folder !== undefined)
}

// Windows' own variables, which its programs need to start and to find the system: the
// machine's, never the developer's.
const systemVariables = [
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
]

/**
 * What a sandbox on Windows adds: the system's variables; the user's folders, as Node,
 * Go and Rust find a home by USERPROFILE and configuration by APPDATA and LOCALAPPDATA
 * there, never HOME; PowerShell's own modules only; and the system's folders on PATH,
 * with git and PowerShell 7 when installed, each by its own install (see `toolFolders`).
 */
const windowsEnvironment = (
  home: string,
  user: string,
  forbidden: readonly string[],
  folder: (...parts: string[]) => string,
): { readonly env: Record<string, string>; readonly path: readonly string[] } => {
  const system = Object.fromEntries(
    systemVariables.flatMap((name) => {
      const value = process.env[name]
      return value ? [[name, value]] : []
    }),
  )
  const root = system.SystemRoot ?? "C:\\Windows"
  const powershell = join(root, "System32", "WindowsPowerShell", "v1.0")
  const temp = folder("tmp")
  return {
    env: {
      ...system,
      USERPROFILE: home,
      HOMEDRIVE: home.slice(0, 2),
      HOMEPATH: home.slice(2),
      USERNAME: user,
      APPDATA: folder("home", "AppData", "Roaming"),
      LOCALAPPDATA: folder("home", "AppData", "Local"),
      TEMP: temp,
      TMP: temp,
      PSModulePath: join(powershell, "Modules"),
    },
    path: [
      join(root, "System32"),
      root,
      join(root, "System32", "Wbem"),
      powershell,
      ...toolFolders(forbidden),
    ],
  }
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
    ? windowsEnvironment(home, user, programs(options.forbidden ?? []), folder)
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
