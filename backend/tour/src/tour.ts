import { homedir } from "node:os"
import { basename } from "node:path"

import type { Effort } from "@novadeck/harness-core/harness"
import { novaProgram } from "@novadeck/harness-nova/launcher"
import type { NovaService } from "@novadeck/harness-nova/ticket"
import type { AgentName, Project, TourPrepared } from "@novadeck/protocol"

import {
  briefFiles,
  keptLine,
  nudgeLine,
  projectNote,
  tourBrief,
  type BriefFacts,
  type Serving,
  type Teammate,
} from "./brief.js"
import { TourError } from "./errors.js"
import {
  chooseTourFolder,
  folderOf,
  hasMarker,
  insideFolder,
  inTourFolder,
  keepTourFolder,
  resetTourFolder,
  tourFolder,
  tourFolderCount,
} from "./folder.js"
import {
  tourAgent,
  tourEffort,
  tourLaunch,
  tourModel,
  tourWrites,
  type TourLaunch,
} from "./launch.js"
import { TourRecords } from "./records.js"
import {
  bringHome,
  commitSandbox,
  laySandbox,
  releaseSandbox,
  requireGit,
  type Git,
} from "./repo.js"
import { seedFiles, type TourAssets } from "./seed.js"
import { findServing, freePort, versionOf, type FindProgram } from "./serving.js"

/**
 * What the runner decides of an agent's `open_agent` in the tour's folder, before anything
 * starts (the runner's `OpenPolicy`): a refusal, or the agent, flags, program and model the
 * lead's teammates start with there, for that launch only.
 */
export type OpenPolicy = {
  readonly refusal?: string
  readonly refuseAgent?: (agent: AgentName, cwd: string) => string | undefined
  readonly flags?: (agent: AgentName, cwd: string) => readonly string[]
  readonly pinned?: (
    agent: AgentName,
    cwd: string,
  ) => { readonly model: string; readonly effort?: Effort } | undefined
  readonly program?: (agent: AgentName, cwd: string) => string | undefined
}

/** What the tour needs of the runner. */
export type TourHost = {
  /** Git, run as the runner runs it for a checkout (its environment, deadline and cap). */
  readonly git: Git
  /** The program of that name on the PATH of `env`, by its absolute path, as terminals find it. */
  readonly findProgram: FindProgram
  readonly home?: string
  readonly platform?: NodeJS.Platform
  /** Where the seed project's files are, where not in the repository (the packaged app). */
  readonly assets?: TourAssets
  /** How the game's dev server is run here, as `findServing` finds; a test brings its own. */
  readonly serving?: () => Promise<Serving | null>
  /**
   * The person's environment as their terminals have it (their login shell's PATH), which the
   * game's server command runs in, so the interpreter is looked for there; the runner's own where
   * omitted.
   */
  readonly environment?: () => NodeJS.ProcessEnv
  /**
   * Nova, which the tour's agents run (`Nova.ready`): resolves once it is in place, and rejects
   * while it is switched off or with the download's own words. Absent where the runner can't
   * start it (no shell files).
   */
  readonly nova?: () => Promise<string>
  /**
   * A fresh ticket of Nova's model service (`NovaTickets.service`), which the runner's Novas then
   * share and the tour's agents run on as every Nova does, through its launcher: asked for each
   * run, as a kept one may be spent, and ahead, so a refusal (the day's tickets used, the free
   * model off) stops the tour before anything changes, in the service's own words. None asked
   * where omitted.
   */
  readonly service?: () => Promise<NovaService>
  /**
   * The runs' leads, by folder (`TourRecords`): kept in a file of the runner's own, so a lead
   * resumed in a runner started again still opens its teammates. In memory where omitted.
   */
  readonly records?: TourRecords
  readonly projects: {
    readonly list: () => readonly Project[]
    /** Removes the project, closing its terminals; resolves where it is gone already. */
    readonly remove: (projectId: string) => Promise<void>
  }
  /** Rings `text` to the terminal's agent as Novadeck's notice; false where it has none yet. */
  readonly notice: (terminalId: string, text: string) => boolean
  /** The terminal's folder now; throws for a terminal the runner doesn't have. */
  readonly cwdOf: (terminalId: string) => string
  /** The terminal that leads this one, if one does. */
  readonly leadOf: (terminalId: string) => string | undefined
  /** The terminal's handle, as agents address it. */
  readonly handleOf: (terminalId: string) => string
  /** Makes the folder agents' worktrees live in, whatever the person's setting. */
  readonly worktreesFolder: () => void
}

// Where the runner can't start Nova.
const noNova = "Novadeck can't start Nova here, so the tour can't start."

// What the run last readied is, once it starts: its folder, its agent's launch, and its terminals.
type Run = {
  readonly launch: TourLaunch
  readonly directory: string
  /** The terminal the lead's brief was rung to. */
  lead?: string
}

/**
 * Novadeck's tour, on the runner's side: its folder, made afresh for each run, and the line
 * that starts its agent there. The client opens the project and the terminal, as it lays them
 * out; see docs/backend-api.md.
 */
export class Tour {
  // The run being readied, so a second start meanwhile doesn't empty its folder under it.
  private preparing: Promise<TourPrepared> | undefined
  // The facts of the run last readied, which its brief is composed of when it is rung.
  private facts: BriefFacts | undefined
  private run: Run | undefined

  // Each folder's run and its lead, which outlive the run in memory (see `leads`).
  private readonly records: TourRecords

  constructor(private readonly host: TourHost) {
    this.records = host.records ?? new TourRecords()
  }

  /**
   * Readies a run of the tour, always on Nova, GPT-6 Luna at medium effort, paid for
   * by Novadeck (`launch.ts`): waits for Nova to be in place (`host.nova`, refused while it is
   * switched off), then picks its folder (`chooseTourFolder`: the first of
   * `tour`, `tour-2`, ... that is missing, empty or the tour's own, passing over any the person
   * kept), asks Nova's model service for its ticket (`host.service`: the one thing that can
   * refuse for a reason of Novadeck's, in the service's own words),
   * removes any project open there, closing its terminals, so nothing runs there; then
   * empties the folder and writes the seed project there (`seedFiles`) with the brief's files;
   * then builds the agent's launch line. The brief never names the person; it names the one
   * teammate the lead opens, on the same agent and model. It also says how the game's
   * dev server is run here (`findServing`), if it can be. The folder is a git repo of its own
   * (`commitSandbox`), so git is needed (`requireGit`, asked first of all). Nova, where it
   * can't be had (a runner without shell files, a download that failed, in its own words) is a
   * `CONFLICT`; so are a ticket refused (a person's tickets for the day used, or the free model
   * off), seed files that can't be read, no folder to use, and a run asked for while another is
   * being readied. Nothing changes for any of them, and a ticket is asked for only once none of
   * the others can refuse.
   */
  prepare(): Promise<TourPrepared> {
    if (this.preparing) return Promise.reject(new TourError("The tour is already starting."))
    const preparing = this.ready().finally(() => {
      this.preparing = undefined
    })
    this.preparing = preparing
    return preparing
  }

  private async ready(): Promise<TourPrepared> {
    const { nova } = this.host
    if (!nova) throw new TourError(noNova)
    try {
      await nova()
    } catch (error) {
      throw new TourError(
        `Novadeck couldn't get Nova, so the tour can't start. ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          600,
        ),
      )
    }
    // Git first of all: the sandbox is a repo, and nothing is removed for a tour that can't be.
    await requireGit(this.host.git)
    // The files and the folder too, the last local checks that can refuse.
    const seed = await seedFiles(this.host.assets)
    const directory = await chooseTourFolder(this.host.home)
    // Nova's ticket, before anything is removed or started: a refusal leaves the person's tour
    // project as it was.
    const given = await this.host.service?.()
    if (given?.ok === false) throw new TourError(given.reason)
    const serving = await (
      this.host.serving ??
      (() => findServing(versionOf(this.host.findProgram), freePort, this.host.environment?.()))
    )()
    // Those being removed too, as their shells may still be closing there: the removal
    // under way is waited for.
    const removed = this.host.projects
      .list()
      .filter(({ cwd }) => insideFolder(cwd, directory, this.host.platform))
      .map(({ id }) => id)
    await Promise.all(removed.map((id) => this.host.projects.remove(id)))
    const mate: Teammate = { agent: tourAgent, model: tourModel, effort: tourEffort }
    // What is committed is the project as the person keeps it: its own note, no tour settings.
    // The tour's rules are laid over it after, where git doesn't see them (`laySandbox`).
    const { "CLAUDE.md": claude = "", ...rules } = briefFiles(tourAgent)
    await resetTourFolder(directory, { ...seed, "AGENTS.md": projectNote, "CLAUDE.md": claude })
    await commitSandbox(this.host.git, directory)
    await laySandbox(this.host.git, directory, rules)
    // Before any agent starts: a process that began without the folder can't write in it.
    this.host.worktreesFolder()
    this.facts = { mate, serving }
    const launch = tourLaunch()
    // This folder's earlier run, if any, is replaced: its agents are gone with its project.
    this.records.set(basename(directory), {})
    this.run = { launch, directory }
    return { ...launch, directory, removed, page: serving !== null }
  }

  /**
   * Rings the lead's brief (`tourBrief`, composed of the run last readied) to the agent in
   * `terminalId` as Novadeck's notice, for every harness (`brief: "doorbell"`): the doorbell
   * delivers it once the agent's prompt shows and its tools are listed. A terminal whose agent
   * hasn't shown yet is a `CONFLICT`; the client asks once it has. So is a runner that has
   * readied no run since it started.
   */
  brief(terminalId: string): void {
    if (!this.facts || !this.run) throw new TourError("The tour hasn't been readied.")
    this.ring(terminalId, tourBrief({ ...this.facts, lead: `@${this.host.handleOf(terminalId)}` }))
    this.run.lead = terminalId
    // Kept with the run's record, so the lead resumed in a runner started again still opens
    // its teammates (`openPolicy`).
    const name = basename(this.run.directory)
    const kept = this.records.get(name)
    if (kept) this.records.set(name, { ...kept, lead: terminalId })
  }

  // Whether the terminal leads the tour's run in its folder: the run's lead in memory, or, in a
  // runner started again, the lead its folder's record names, while the folder is still the tour's.
  private leads(terminalId: string, cwd: string): boolean {
    if (this.run) return terminalId === this.run.lead
    const folder = folderOf(
      cwd,
      this.host.home ?? homedir(),
      this.host.platform ?? process.platform,
    )
    return folder !== undefined && this.records.get(basename(folder))?.lead === terminalId
  }

  /**
   * The tour has no artist any more (its story has a modeller and a builder, both the lead's):
   * always a `CONFLICT`, for a client that still asks.
   */
  artist(_terminalId: string): void {
    throw new TourError("The tour has no artist.")
  }

  /**
   * The person keeps the project, which the client asks once the tour's story has ended, and
   * again if the person presses its button. The team's work comes home first (`bringHome`: the
   * folder holds what the dev server last served, committed on main, and the worktrees are moved
   * to that commit). The run's folder stops being the tour's
   * (`releaseSandbox`: the project's own note back in `AGENTS.md`, git told of no rules laid over
   * it; `keepTourFolder`: its settings and marker gone), its lead is told the tour is over (best
   * effort: it may be gone or not listening, and only a lead the run knows is told), and the run
   * is forgotten, so a later run starts in another folder and nothing of the tour's rules holds
   * here. With no run in memory (the runner started since) it keeps every folder of the tour's
   * that holds the marker and is open as a project; with none, it does nothing. A folder already
   * kept is no one's to keep again, so a repeat is harmless.
   */
  async keep(): Promise<void> {
    const { run } = this
    const folders = run ? [run.directory] : this.openFolders()
    for (const folder of folders) {
      if (!hasMarker(folder)) continue
      // While the tour's files are still kept out of git, so the commit takes none of them.
      // eslint-disable-next-line no-await-in-loop -- One folder at a time, as one is ever open.
      await bringHome(this.host.git, folder)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await releaseSandbox(this.host.git, folder, projectNote)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await keepTourFolder(folder)
    }
    this.run = undefined
    this.facts = undefined
    if (run?.lead !== undefined) {
      try {
        this.host.notice(run.lead, keptLine)
      } catch {
        // The lead is gone: nobody to tell.
      }
    }
  }

  // The tour's folders that hold the marker and are open as a project, which the runner keeps
  // across a restart while its run in memory is gone.
  private openFolders(): string[] {
    const open = this.host.projects.list()
    return Array.from({ length: tourFolderCount }, (_, index) =>
      tourFolder(this.host.home, index + 1),
    ).filter(
      (folder) =>
        hasMarker(folder) && open.some(({ cwd }) => insideFolder(cwd, folder, this.host.platform)),
    )
  }

  /**
   * Rings the agent in `terminalId` to carry on with its brief from the step it is on, where it
   * has gone quiet: a fixed line, as Novadeck's notice. Refused as `brief` is.
   */
  nudge(terminalId: string): void {
    this.ring(terminalId, nudgeLine)
  }

  /**
   * What an `open_agent` of `terminalId` is subject to: only the run's lead opens agents in the
   * tour's folder, with the tour's write flags; every other terminal there, its teammates, is
   * refused. A teammate the lead opens in the folder is Nova (`program`), on the
   * run's own model and effort whatever the call names, never judged against the person's models,
   * as the service the tour pays for isn't theirs (`pinned`); its ticket comes through Nova's
   * launcher, as every Nova's does.
   * A terminal elsewhere, and one the runner doesn't have, are left to the call's own checks.
   */
  openPolicy(terminalId: string): OpenPolicy {
    let cwd: string
    try {
      cwd = this.host.cwdOf(terminalId)
    } catch {
      return {}
    }
    if (!this.inTour(cwd)) return {}
    // The lead's teammates write in the folder unasked, for that launch only (`tourWrites`), and
    // only where they start in it: one it opens elsewhere gets none.
    return this.leads(terminalId, cwd)
      ? {
          refuseAgent: (agent, at) =>
            agent !== tourAgent && this.inTour(at)
              ? 'The tour runs Nova only: open your teammates with agent "pi".'
              : undefined,
          flags: (agent, at) => (agent === tourAgent && this.inTour(at) ? tourWrites : []),
          program: (agent, at) =>
            agent === tourAgent && this.inTour(at) ? novaProgram : undefined,
          pinned: (agent, at) =>
            agent === tourAgent && this.inTour(at)
              ? { model: tourModel, effort: tourEffort }
              : undefined,
        }
      : {
          refusal:
            "Only the lead of Novadeck's tour opens agents in its project. Do only the task in your message.",
        }
  }

  /**
   * Whether the terminal is one of the tour's, in its folder: its agents use worktrees
   * whatever the person's setting says. False for a terminal the runner doesn't have.
   */
  isTours(terminalId: string): boolean {
    try {
      return this.inTour(this.host.cwdOf(terminalId))
    } catch {
      return false
    }
  }

  // Whether `path` is in the tour's folder: one of its names, with its marker still there.
  private inTour(path: string): boolean {
    return inTourFolder(path, this.host.home, this.host.platform)
  }

  // Only the tour's own terminals, those in its folder, are rung; one elsewhere is a
  // `CONFLICT`, as is one whose agent hasn't shown yet.
  private ring(terminalId: string, line: string): void {
    const cwd = this.host.cwdOf(terminalId)
    if (!this.inTour(cwd)) throw new TourError("The terminal isn't one of the tour's.")
    if (!this.host.notice(terminalId, line))
      throw new TourError("The terminal's agent hasn't started yet.")
  }
}
