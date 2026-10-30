import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

// The value `ask` gives, asked once a run.
const once = <T>(ask: () => T): (() => T) => {
  let asked: { readonly value: T } | undefined
  return () => (asked ??= { value: ask() }).value
}

// The first folder on the caller's own PATH holding the program, for the system tools a
// sandbox on Windows needs (git, PowerShell 7), never a program under test.
const onPath = (program: string): string | undefined =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .find((folder) => existsSync(join(folder, program)))

// What a program prints, or undefined should it fail.
const output = (program: string, args: readonly string[]): string | undefined => {
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

/**
 * The git on the caller's PATH: the folder it was found in, and Git for Windows' own
 * install, `<Git>`, three folders above `git --exec-path`'s `<Git>\mingw64\libexec\git-core`
 * where `<Git>\cmd\git.exe` is there. An MSYS2 or Cygwin git (`/usr/lib/git-core`) has
 * none such, its install unknown.
 */
const gitOnPath = once(() => {
  const found = onPath("git.exe")
  if (!found) return undefined
  const core = output(join(found, "git.exe"), ["--exec-path"])
  const install = core && dirname(dirname(dirname(core)))
  return {
    found,
    install: install && existsSync(join(install, "cmd", "git.exe")) ? install : undefined,
  }
})

/**
 * Git for Windows' bash, which some programs on Windows run their shell commands in and
 * won't start without: `<Git>\bin\bash.exe` of the install the sandbox's PATH has (see
 * `gitOnPath`). Where that isn't known, it is looked for above the folder the git was
 * found in, whether `<Git>\cmd`, as an install puts on PATH, `<Git>\bin`, or
 * `<Git>\mingw64\bin`, first on PATH under Git's own bash, as CI's steps run.
 */
export const gitBash = (): string | undefined => {
  const git = gitOnPath()
  if (!git) return undefined
  const above = git.install
    ? [git.install]
    : [git.found, dirname(git.found), dirname(dirname(git.found))]
  return above.map((root) => join(root, "bin", "bash.exe")).find((path) => existsSync(path))
}

/**
 * PowerShell 7's own install, `$PSHOME`, which it prints as base64, as a pipe gets the
 * console's code page, which would lose a folder's name past ASCII (`C:\Users\Łukasz`).
 */
const pwshHome = once(() => {
  const found = onPath("pwsh.exe")
  const printed =
    found &&
    output(join(found, "pwsh.exe"), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PSHOME))",
    ])
  const home = printed && Buffer.from(printed, "base64").toString("utf8")
  return home && existsSync(join(home, "pwsh.exe")) ? home : undefined
})

// Programs a folder on the sandbox's PATH must never hold, as a tool's folder may: Node,
// which installs programs globally beside it, and those the caller names (see
// `SandboxOptions.forbidden`).
const forbiddenPrograms = (names: readonly string[]): readonly string[] =>
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
 * install, as it reports it, not the folder the caller found it in, which may be a package
 * manager's (scoop's `shims`, Chocolatey's `bin`) holding a shim of every global tool, a
 * forbidden program among them. Not the programs alone, linked: Git's `cmd\git.exe` finds
 * the rest of Git by its own path, as `pwsh.exe` its libraries, and a shim its `.shim`.
 * Git's is `<Git>\cmd` (see `gitOnPath`); PowerShell's is `$PSHOME`. Where either can't be
 * told, as for an MSYS2 git, the folder it was found in stands in (see `standIn`), rather
 * than leaving it off PATH for a program to fail on later, unclearly.
 */
const toolFolders = (forbidden: readonly string[]): readonly string[] => {
  const git = gitOnPath()
  const pwsh = onPath("pwsh.exe")
  return [
    git && (git.install ? join(git.install, "cmd") : standIn(git.found, "git", forbidden)),
    pwshHome() ?? (pwsh && standIn(pwsh, "PowerShell 7", forbidden)),
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
 * `forbidden` are the programs the caller names besides Node's, without their extension;
 * `folder` makes a folder inside the sandbox.
 */
export const windowsEnvironment = (
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
      ...toolFolders(forbiddenPrograms(forbidden)),
    ],
  }
}
