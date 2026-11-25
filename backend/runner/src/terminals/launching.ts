import { randomBytes, randomUUID } from "node:crypto"
import { constants, rmSync, writeFileSync } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath, win32 } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"
import { TerminalError } from "@novadeck/terminal"
import type { RunSpec, Terminal } from "@novadeck/terminal/host"
import { pathKey, refreshPath, startsCommands, type ShellLaunch } from "@novadeck/terminal/shell"

import { bundledFetch } from "../bundled/pi.js"
import { DomainError } from "../errors.js"
import { agents, harnesses } from "../harnesses/registry.js"
import { locate } from "../harnesses/service.js"
import { captureVariable, prepareCaptureFolder } from "../shell/capture.js"
import type { InstalledShell } from "../shell/install.js"
import { shellLaunch } from "../shell/integration.js"
import { listenForReports, type ReportHandlers, type Reports } from "../shell/reports.js"
import { failed } from "./failures.js"
import type { Started } from "./record.js"

/** The runner's shell integration, once its files are written and reports are heard. */
export type Integration = {
  readonly paths: InstalledShell
  readonly reports: Reports
}

type Size = { cols: number; rows: number }

/**
 * `error` as the caller sees it: a shell that didn't start is `SPAWN_FAILED`, and the
 * command it was to take never runs.
 */
export const startFailed = (started: Started, error: unknown): unknown => {
  if (!(error instanceof TerminalError && error.code === "SPAWN_FAILED")) return error
  if (started.resumeFile) rmSync(started.resumeFile, { force: true })
  return new DomainError("SPAWN_FAILED", "Could not start the configured shell.")
}

/** `start()`'s terminal for `started`; a shell that didn't start is `SPAWN_FAILED`, its command never run. */
export const startedIn = (started: Started, start: () => Terminal): Terminal => {
  try {
    return start()
  } catch (error) {
    throw startFailed(started, error)
  }
}

/**
 * `env` with each of `folders` last on its PATH, unless PATH has it: Windows' names have no
 * case and may end in a separator, so there "C:\\Tools\\" and "c:\\tools" are one folder.
 */
export const withFolders = (
  env: NodeJS.ProcessEnv,
  folders: readonly string[],
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv => {
  const windows = platform === "win32"
  const separator = windows ? ";" : ":"
  const same = (folder: string): string =>
    windows ? folder.replace(/[\\/]+$/, "").toLowerCase() : folder
  const key = pathKey(env)
  const have = new Set((env[key] ?? "").split(separator).map(same))
  const added: string[] = []
  for (const folder of folders)
    if (!have.has(same(folder))) {
      have.add(same(folder))
      added.push(folder)
    }
  if (added.length === 0) return env
  return {
    ...env,
    [key]: [env[key], ...added].filter(Boolean).join(separator),
  }
}

export type LauncherOptions = {
  readonly shell: string
  readonly shellArgs: readonly string[] | undefined
  /** The environment shells start from, with the runner's own variables taken out. */
  readonly env: NodeJS.ProcessEnv
  /**
   * What a shell starting in `cwd` gets on top of it, for that shell alone; `resumed` where it is
   * a terminal's start again (a restart, a restore, or a session resumed) and not a new one.
   */
  readonly launchEnv: (cwd: string, resumed: boolean) => NodeJS.ProcessEnv | undefined
  /** Whether each new shell's PATH is read anew (see `refreshPath`). */
  readonly freshPath: boolean
  /** The runner's own relay, which on Windows reads the registry's PATH. */
  readonly relay: string
  /** The connected harnesses whose shims new shells put first on PATH. */
  readonly shims: () => Promise<readonly AgentName[]>
  /** Whether Novadeck's plugin is installed into the harness. */
  readonly connected: (agent: AgentName) => Promise<boolean>
  /** Where each harness lives, which says where its installer puts the program. */
  readonly install: (agent: AgentName) => Promise<Install | undefined>
}

export type LauncherHost = {
  /** The runner is stopping: the integration that came up meanwhile is closed again. */
  readonly stopping: () => boolean
  /** Where each shell goes as it starts, which a startup command waits for. */
  readonly scopes: { active(): boolean } | undefined
  /** What hears agents' reports, asks, acknowledgements and tool calls. */
  readonly handlers: ReportHandlers
}

/**
 * How a terminal's shell starts: in which directory, which program, with what
 * environment, and, with the runner's shell integration, the hook's launcher, the endpoint
 * and token its connected agents report with, and a command to run at its first prompt.
 */
export class Launcher {
  /** The runner's shell integration, once listening; undefined without it. */
  private integration: Promise<Integration | undefined> = Promise.resolve(undefined)

  constructor(
    private readonly options: LauncherOptions,
    readonly host: LauncherHost,
  ) {}

  /** Listens for agent reports once the shell files are written; shells start plainly without. */
  integrate(shellFiles: Promise<InstalledShell | undefined> | undefined): void {
    this.integration = this.listen(shellFiles)
  }

  private async listen(
    shellFiles: Promise<InstalledShell | undefined> | undefined,
  ): Promise<Integration | undefined> {
    try {
      const paths = await shellFiles
      if (!paths) return undefined
      // A launcher of Novadeck's own pi has the runner fetch it (bundled/pi.ts).
      const reports = await listenForReports({
        ...this.host.handlers,
        fetch: bundledFetch(paths.bundledPi.data),
      })
      if (!this.host.stopping()) return { paths, reports }
      await reports.close()
    } catch (error) {
      failed.integration(error)
    }
    return undefined
  }

  /** The runner's shell integration, once listening; undefined without it. */
  integrated(): Promise<Integration | undefined> {
    return this.integration
  }

  /** Whether `agent` is connected; false without one, or when that cannot be told. */
  async connected(agent: AgentName | undefined): Promise<boolean> {
    return agent !== undefined && (await this.options.connected(agent).catch(() => false))
  }

  /** The integration for a new shell, with the connected harnesses whose shims it gets. */
  async shellIntegration(): Promise<(Integration & { shims: readonly AgentName[] }) | undefined> {
    const integration = await this.integration
    if (!integration) return undefined
    return {
      ...integration,
      shims: await this.options.shims().catch(() => []),
    }
  }

  /** Whether a terminal created now could start a command; see `launch`. */
  async startsCommands(): Promise<boolean> {
    const integration = await this.integration
    return (
      integration !== undefined &&
      this.options.shellArgs === undefined &&
      startsCommands(this.options.shell)
    )
  }

  async directory(cwd: string): Promise<string> {
    try {
      if (!isAbsolute(cwd)) throw new Error("Relative directory")
      const path = await realpath(cwd)
      if (!(await stat(path)).isDirectory()) throw new Error("Not a directory")
      await access(path, constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK))
      return path
    } catch {
      throw new DomainError(
        "INVALID_DIRECTORY",
        "Terminal working directory must be an accessible absolute directory.",
      )
    }
  }

  /**
   * The environment a new shell starts from: the runner's, with PATH read anew where
   * `freshPath` asks for it, as a Windows app keeps the PATH it was started with, and with
   * the folders of the agents it only finds beside PATH (see `programFolders`) put last.
   */
  async environment(): Promise<NodeJS.ProcessEnv> {
    const env = this.options.freshPath
      ? await refreshPath(this.options.env, { relay: this.options.relay })
      : this.options.env
    return withFolders(env, await this.programFolders(env), process.platform)
  }

  /**
   * The folders of the agents' programs that `env`'s PATH lacks, as the installers leave them
   * (`Harness.fallbacks`): `claude` typed in a new shell, or the shim that starts it, then
   * finds the program an install just put in `~/.local/bin`, where macOS' PATH has none.
   */
  private async programFolders(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
    const found = await Promise.all(
      agents.map(async (agent) => {
        try {
          const install = await this.options.install(agent)
          const program = install && (await locate(agent, harnesses[agent], { ...install, env }))
          if (!program) return undefined
          return install.platform === "win32" ? win32.dirname(program) : dirname(program)
        } catch {
          return undefined
        }
      }),
    )
    return found.filter((folder) => folder !== undefined)
  }

  /** The shell's program, a name found on the PATH the new shell gets, as `environment`. */
  async executable(cwd: string, environment: Promise<NodeJS.ProcessEnv>): Promise<string> {
    const shell = this.options.shell
    const named = !(isAbsolute(shell) || shell.includes("/") || shell.includes("\\"))
    const env = named ? await environment : this.options.env
    const paths = named
      ? (env[pathKey(env)] ?? "").split(delimiter).map((path) => resolvePath(cwd, path, shell))
      : [resolvePath(cwd, shell)]
    const suffixes =
      process.platform === "win32"
        ? ["", ...(this.options.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
        : [""]
    const candidates = paths.flatMap((path) => suffixes.map((suffix) => `${path}${suffix}`))
    const available = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          if (!(await stat(candidate)).isFile()) return undefined
          await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK)
          return candidate
        } catch {
          return undefined
        }
      }),
    )
    const executable = available.find((candidate) => candidate !== undefined)
    if (executable) return executable
    throw new DomainError("SPAWN_FAILED", "Configured shell must be an executable file.")
  }

  /**
   * A shell's run, for a terminal to start; the caller attaches it to a record. Every shell
   * knows its terminal's id; with the integration it also loads it, and gets the hook's
   * launcher and the endpoint and token its connected agents report with. A `startup`
   * command runs as the integration starts; configured shell arguments leave it out,
   * unless it is `required`, when the shell does not start without it.
   */
  launch(
    shell: string,
    cwd: string,
    input: Size & { id?: string; terminalId?: string },
    integration: (Integration & { shims: readonly AgentName[] }) | undefined,
    base: NodeJS.ProcessEnv,
    startup?: { readonly command: string; readonly required?: boolean },
    resumed = false,
  ): { spec: RunSpec; started: Started } {
    const { cols, rows } = input
    const id = input.id ?? input.terminalId ?? ""
    const token = randomBytes(24).toString("hex")
    const launch = (withStartup: boolean): ShellLaunch =>
      integration
        ? shellLaunch(shell, integration.paths, base, {
            shims: integration.shims,
            scoped: this.host.scopes?.active(),
            ...(withStartup &&
              startup &&
              this.options.shellArgs === undefined && {
                startup: {
                  command: startup.command,
                  file: join(integration.paths.resume, randomUUID()),
                },
              }),
          })
        : { args: [], env: base, integrated: false, resumes: false }
    let launched = launch(true)
    // The shell reads the command from a file only it and the runner can read.
    if (launched.resumeFile)
      try {
        writeFileSync(launched.resumeFile, startup!.command, {
          mode: 0o600,
          flag: "wx",
        })
      } catch {
        launched = launch(false)
      }
    if (startup?.required && !launched.resumes)
      throw new DomainError("SPAWN_FAILED", "This terminal's shell can't start a command.")
    const { resumeFile } = launched
    // Where an agent that writes its commands' output nowhere readable (Codex) has Novadeck
    // capture it, for the terminal's companion pane (see shell/capture.ts).
    const capture = integration ? prepareCaptureFolder(id) : undefined
    const env: NodeJS.ProcessEnv = {
      ...launched.env,
      ...this.options.launchEnv(cwd, resumed),
      NOVADECK_TERMINAL_ID: id,
      ...(integration && {
        NOVADECK_REPORT: integration.reports.endpoint,
        NOVADECK_REPORT_TOKEN: token,
      }),
      ...(capture !== undefined && { [captureVariable]: capture }),
    }
    return {
      spec: {
        file: shell,
        args: this.options.shellArgs ?? launched.args,
        cwd,
        env,
        cols,
        rows,
        ...(launched.scopeFile !== undefined && {
          scopeFile: launched.scopeFile,
        }),
      },
      started: {
        token,
        resumes: launched.resumes,
        resumeFile,
        resumeClaim: undefined,
        resumeEnded: undefined,
        resumeTurn: undefined,
        resumeTold: undefined,
      },
    }
  }
}
