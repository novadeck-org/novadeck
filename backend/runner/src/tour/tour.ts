import type { AgentName, Project, TourPrepared } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { agentLabel } from "../messaging/messages.js"
import { mention } from "../terminals/handles.js"
import type { OpenPolicy } from "../terminals/options.js"
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
import {
  chooseTourFolder,
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
  tourConfig,
  tourEffort,
  tourLaunch,
  tourModel,
  tourWrites,
  type TourLaunch,
} from "./launch.js"
import { bringHome, commitSandbox, laySandbox, releaseSandbox, requireGit } from "./repo.js"
import { seedFiles, type TourAssets } from "./seed.js"
import { findServing, freePort, versionOf } from "./serving.js"
import { fetchTicket, tourEndpoint } from "./ticket.js"

/** What the tour needs of the runner. */
export type TourHost = {
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
  readonly connected: (agent: AgentName) => Promise<boolean>
  /**
   * A ticket for one run, which the tour's agents' provider takes as its key (`fetchTicket`, from
   * the service at `tourEndpoint()`); a refusal is a `DomainError` in words for the person.
   */
  readonly ticket?: () => Promise<string>
  readonly projects: {
    readonly list: () => readonly Project[]
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

// What the run last readied is, once it starts: its folder, its agent's launch, and its terminals.
type Run = {
  readonly launch: TourLaunch
  readonly directory: string
  /** What the run's terminals in its folder start with: the provider and model of its agents. */
  readonly env: NodeJS.ProcessEnv
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

  constructor(private readonly host: TourHost) {}

  /**
   * Readies a run of the tour, always on opencode, GPT-6 Luna at medium effort, paid for by
   * Novadeck (`launch.ts`): picks its folder (`chooseTourFolder`: the first of
   * `tour`, `tour-2`, ... that is missing, empty or the tour's own, passing over any the person
   * kept), gets a ticket from the tour's service (`host.ticket`: the agents' provider key, and
   * the one thing that can refuse for a reason of Novadeck's, in the service's own words),
   * removes any project open there, closing its terminals, so nothing runs there; then
   * empties the folder and writes the seed project there (`seedFiles`) with the brief's files;
   * then builds the agent's launch line. The brief never names the person; it names the one
   * teammate the lead opens, on the same agent and model. It also says how the game's
   * dev server is run here (`findServing`), if it can be. The folder is a git repo of its own
   * (`commitSandbox`), so git is needed (`requireGit`, asked first of all). opencode not being
   * connected to Novadeck is a `CONFLICT`, as its tools would be missing; so are a ticket
   * refused (a person's tickets for the day used, or the free runs off), seed files that
   * can't be read, no folder to use, and a run asked for while another is being readied.
   * Nothing changes for any of them, and a ticket is asked for only once none of the others
   * can refuse.
   */
  prepare(): Promise<TourPrepared> {
    if (this.preparing)
      return Promise.reject(new DomainError("CONFLICT", "The tour is already starting."))
    const preparing = this.ready().finally(() => {
      this.preparing = undefined
    })
    this.preparing = preparing
    return preparing
  }

  private async ready(): Promise<TourPrepared> {
    if (!(await this.host.connected(tourAgent)))
      throw new DomainError(
        "CONFLICT",
        `Novadeck isn't connected to ${agentLabel(tourAgent)}, so the tour can't start.`,
      )
    // Git first of all: the sandbox is a repo, and nothing is removed for a tour that can't be.
    await requireGit()
    // The files and the folder too, the last local checks that can refuse.
    const seed = await seedFiles(this.host.assets)
    const directory = await chooseTourFolder(this.host.home)
    // The ticket, before anything is removed or started: a refusal leaves the person's tour
    // project as it was.
    const ticket = await (this.host.ticket ?? (() => fetchTicket(tourEndpoint())))()
    const serving = await (
      this.host.serving ?? (() => findServing(versionOf, freePort, this.host.environment?.()))
    )()
    // Those being removed too, as their shells may still be closing there: the removal
    // under way is waited for.
    const removed = this.host.projects
      .list()
      .filter(({ cwd }) => insideFolder(cwd, directory, this.host.platform))
      .map(({ id }) => id)
    await Promise.all(
      removed.map((id) =>
        Promise.resolve()
          .then(() => this.host.projects.remove(id))
          .catch((error: unknown) => {
            // Removed meanwhile, as from another window.
            if (!(error instanceof DomainError && error.code === "NOT_FOUND")) throw error
          }),
      ),
    )
    const mate: Teammate = { agent: tourAgent, model: tourModel, effort: tourEffort }
    // What is committed is the project as the person keeps it: its own note, no tour settings.
    // The tour's rules are laid over it after, where git doesn't see them (`laySandbox`).
    const { "CLAUDE.md": claude = "", ...rules } = briefFiles(tourAgent)
    await resetTourFolder(directory, { ...seed, "AGENTS.md": projectNote, "CLAUDE.md": claude })
    await commitSandbox(directory)
    await laySandbox(directory, rules)
    // Before any agent starts: a process that began without the folder can't write in it.
    this.host.worktreesFolder()
    this.facts = { mate, serving }
    const launch = tourLaunch()
    this.run = {
      launch,
      directory,
      env: { NOVADECK_OPENCODE_CONFIG: tourConfig(tourEndpoint(), ticket) },
    }
    return { ...launch, directory, removed, page: serving !== null }
  }

  /**
   * What a new terminal starting in `cwd` gets in its environment on top of the person's: for one
   * in the run's folder, the provider and model of the tour's agents (`tourConfig`), so the
   * lead and every teammate it opens run on the ticket whatever the command line says, and
   * their ticket is in no line of any screen or history. None elsewhere, and none once the
   * person keeps the project (`keep`).
   */
  launchEnv(cwd: string): NodeJS.ProcessEnv | undefined {
    return this.run && this.inTour(cwd) ? this.run.env : undefined
  }

  /**
   * Rings the lead's brief (`tourBrief`, composed of the run last readied) to the agent in
   * `terminalId` as Novadeck's notice, for every harness (`brief: "doorbell"`): the doorbell
   * delivers it once the agent's prompt shows and its tools are listed. A terminal whose agent
   * hasn't shown yet is a `CONFLICT`; the client asks once it has. So is a runner that has
   * readied no run since it started.
   */
  brief(terminalId: string): void {
    if (!this.facts || !this.run) throw new DomainError("CONFLICT", "The tour hasn't been readied.")
    this.ring(
      terminalId,
      tourBrief({ ...this.facts, lead: mention(this.host.handleOf(terminalId)) }),
    )
    this.run.lead = terminalId
  }

  /**
   * The tour has no artist any more (its story has a modeller and a builder, both the lead's):
   * always a `CONFLICT`, for a client that still asks.
   */
  artist(_terminalId: string): void {
    throw new DomainError("CONFLICT", "The tour has no artist.")
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
      await bringHome(folder)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await releaseSandbox(folder, projectNote)
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
   * refused. An opencode teammate the lead opens in the folder starts on the run's own model and
   * effort whatever the call names, never judged against the person's models, as the provider
   * the tour pays for isn't theirs (`pinned`); its provider comes with its shell (`launchEnv`).
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
    return terminalId === this.run?.lead
      ? {
          flags: (agent, at) => (agent === tourAgent && this.inTour(at) ? tourWrites : []),
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
    if (!this.inTour(cwd))
      throw new DomainError("CONFLICT", "The terminal isn't one of the tour's.")
    if (!this.host.notice(terminalId, line))
      throw new DomainError("CONFLICT", "The terminal's agent hasn't started yet.")
  }
}
