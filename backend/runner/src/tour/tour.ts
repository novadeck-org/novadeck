import { posix, win32 } from "node:path"

import type { Model } from "@novadeck/harness-core/harness"
import type { AgentName, Project, TourPrepared } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { agentLabel } from "../messaging/messages.js"
import { mention } from "../terminals/handles.js"
import type { OpenPolicy } from "../terminals/options.js"
import {
  briefFiles,
  nudgeLine,
  secondFixerBrief,
  tourBrief,
  type BriefFacts,
  type Teammate,
} from "./brief.js"
import { checkTourFolder, resetTourFolder, tourFolder } from "./folder.js"
import { tourChoice, tourLaunch, tourWrites, type TourLaunch } from "./launch.js"
import { commitSandbox, requireGit } from "./repo.js"

/** What the tour needs of the runner. */
export type TourHost = {
  readonly home?: string
  readonly platform?: NodeJS.Platform
  readonly connected: (agent: AgentName) => Promise<boolean>
  readonly models: (agent: AgentName) => Promise<readonly Model[]>
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
  /** Whether the terminal is a plain shell at its prompt: no agent has run in it, and none runs. */
  readonly isFreshShell: (terminalId: string) => boolean
  /**
   * Makes the terminal `leadId`'s teammate, as `join` does once approved, and tells the lead:
   * no approval is asked, as the person asked for it by opening the terminal. It waits for the
   * shell's first prompt first, then calls `before`, which may throw to refuse, and only then
   * adopts.
   */
  readonly adopt: (terminalId: string, leadId: string, before: () => void) => Promise<void>
  /** Expects `agent` in the terminal, so a notice rung to it waits for its first session. */
  readonly expect: (terminalId: string, agent: AgentName) => void
  /** Types a command line into the terminal's shell for the client `ownerId` that controls it. */
  readonly type: (terminalId: string, line: string, ownerId: string) => void
  /** Makes the folder agents' worktrees live in, whatever the person's setting. */
  readonly worktreesFolder: () => void
}

// What the run last readied is, once it starts: its agent's launch, and its terminals.
type Run = {
  readonly agent: AgentName
  readonly launch: TourLaunch
  /** The terminal the lead's brief was rung to. */
  lead?: string
  /** The terminal of the second fixer, the person's own agent. */
  fixer?: string | undefined
}

// The order a second harness is looked for in, for the designer of a mixed team.
const agentOrder: readonly AgentName[] = ["claude", "codex", "agy"]

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
   * Readies a run of the tour with `agent`: removes any project open at its folder, closing
   * its terminals, so nothing runs there; then empties the folder and writes the brief there;
   * then builds the agent's launch line, on its cheapest model. The brief never names the
   * person; it names the one teammate the lead opens, on its harness's cheapest model: another
   * connected harness's where one lists its cheapest, else `agent`'s. The folder is a git repo
   * of its own (`commitSandbox`), so git is needed (`requireGit`, asked first of all). An agent Novadeck isn't
   * connected to is a `CONFLICT`, as its tools would be missing; so is a folder that isn't
   * Novadeck's (`checkTourFolder`, asked before any project is removed), and a run asked for
   * while another is being readied. One
   * whose cheapest model can't be told is `MODELS_UNLISTED`: Codex lists its models only once
   * it has started signed in (probed 2026-11-15, 0.169.0: a start not signed in writes no
   * models_cache.json). Nothing changes for any of them.
   */
  prepare(agent: AgentName): Promise<TourPrepared> {
    if (this.preparing)
      return Promise.reject(new DomainError("CONFLICT", "The tour is already starting."))
    const preparing = this.ready(agent).finally(() => {
      this.preparing = undefined
    })
    this.preparing = preparing
    return preparing
  }

  private async ready(agent: AgentName): Promise<TourPrepared> {
    if (!(await this.host.connected(agent)))
      throw new DomainError(
        "CONFLICT",
        `Novadeck isn't connected to ${agentLabel(agent)}, so the tour can't start with it.`,
      )
    // Git first of all: the sandbox is a repo, and nothing is removed for a tour that can't be.
    await requireGit()
    // Its cheapest model first, before anything is removed: the person agreed to that one.
    const models = await this.host.models(agent).catch((): readonly Model[] => [])
    if (tourChoice(agent, models).model === undefined)
      throw new DomainError(
        "MODELS_UNLISTED",
        `${agentLabel(agent)} hasn't listed its models here yet, so the tour can't pick its cheapest. Start ${agentLabel(agent)} and sign in, then take the tour.`,
      )
    const directory = tourFolder(this.host.home)
    // The folder's own refusal too, the last that can refuse, before anything is removed.
    await checkTourFolder(directory)
    // Those being removed too, as their shells may still be closing there: the removal
    // under way is waited for.
    const removed = this.host.projects
      .list()
      .filter(({ cwd }) => withinFolder(cwd, directory, this.host.platform))
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
    const fixer = await this.fixerFor(agent, models)
    await resetTourFolder(directory, briefFiles)
    await commitSandbox(directory)
    // Before any agent starts: a process that began without the folder can't write in it.
    this.host.worktreesFolder()
    this.facts = { fixer }
    const launch = tourLaunch(agent, { models })
    this.run = { agent, launch }
    return { ...launch, directory, removed }
  }

  // The first fixer's harness: the first other connected one whose cheapest model is listed,
  // else the lead's own.
  private async fixerFor(agent: AgentName, models: readonly Model[]): Promise<Teammate> {
    for (const other of agentOrder.filter((each) => each !== agent)) {
      // eslint-disable-next-line no-await-in-loop -- The first that fits is taken.
      if (!(await this.host.connected(other).catch(() => false))) continue
      // eslint-disable-next-line no-await-in-loop -- As above.
      const listed = await this.host.models(other).catch((): readonly Model[] => [])
      const found = teammate(other, listed)
      if (found) return found
    }
    return teammate(agent, models)!
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
   * Takes the terminal the person opened, a plain shell in the tour's folder, as the run's
   * second fixer, by the client `ownerId` that controls it: types the run's agent launch there
   * (its cheapest model, its write flags), makes the run's lead its lead, and rings it its
   * brief, which waits for the agent's first session as any message to an agent that is
   * starting does. Once a run: a terminal outside the tour's folder or with an agent or a lead
   * already, a lead that hasn't started or is gone, or a run that has its second fixer is a
   * `CONFLICT`, and nothing changes.
   */
  async fixer(terminalId: string, ownerId: string): Promise<void> {
    const { run } = this
    if (!run) throw new DomainError("CONFLICT", "The tour hasn't been readied.")
    if (run.lead === undefined) throw new DomainError("CONFLICT", "The tour's lead hasn't started.")
    if (run.fixer !== undefined)
      throw new DomainError("CONFLICT", "The tour's second fixer has started already.")
    const lead = run.lead
    const check = (): void => {
      if (
        !withinFolder(this.host.cwdOf(terminalId), tourFolder(this.host.home), this.host.platform)
      )
        throw new DomainError("CONFLICT", "The terminal isn't one of the tour's.")
      if (terminalId === lead || this.host.leadOf(terminalId) !== undefined)
        throw new DomainError("CONFLICT", "The terminal is the lead or a teammate already.")
      if (!this.host.isFreshShell(terminalId))
        throw new DomainError("CONFLICT", "The terminal isn't a plain shell at its prompt.")
      try {
        this.host.cwdOf(lead)
      } catch {
        throw new DomainError("CONFLICT", "The tour's lead is gone.")
      }
    }
    check()
    // Claimed first, so a second call meanwhile is refused; given back where a step fails.
    run.fixer = terminalId
    try {
      // Once its shell has shown its first prompt, so what is typed isn't read by a profile
      // still loading; checked again then, as the person may have used the shell meanwhile.
      await this.host.adopt(terminalId, lead, () => {
        check()
        this.host.type(terminalId, run.launch.command, ownerId)
      })
    } catch (error) {
      run.fixer = undefined
      throw error
    }
    this.host.expect(terminalId, run.agent)
    this.ring(terminalId, secondFixerBrief(mention(this.host.handleOf(lead))))
  }

  /**
   * Rings the agent in `terminalId` to carry on with its brief from the step it is on, where it
   * has gone quiet: a fixed line, as Novadeck's notice. Refused as `brief` is.
   */
  nudge(terminalId: string): void {
    this.ring(terminalId, nudgeLine)
  }

  /**
   * What an `open_agent` of `terminalId` is subject to: a terminal in the tour's folder that has
   * a lead is a teammate, and only the tour's lead opens agents there, so it is refused. The
   * lead (no lead of its own) opens them with the tour's write flags; a led terminal elsewhere,
   * and a terminal the runner doesn't have, are left to the call's own checks.
   */
  openPolicy(terminalId: string): OpenPolicy {
    let cwd: string
    try {
      cwd = this.host.cwdOf(terminalId)
    } catch {
      return {}
    }
    if (!withinFolder(cwd, tourFolder(this.host.home), this.host.platform)) return {}
    // The lead's fixers write in the folder unasked, for that launch only (`tourWrites`), and
    // only where they start in it: one it opens elsewhere gets none.
    return this.host.leadOf(terminalId) === undefined
      ? {
          flags: (agent, at) =>
            withinFolder(at, tourFolder(this.host.home), this.host.platform)
              ? tourWrites[agent]
              : [],
        }
      : {
          refusal:
            "You're a teammate in Novadeck's tour: only the tour's lead opens agents. Do only the task in your lead's message.",
        }
  }

  /**
   * Whether the terminal is one of the tour's, in its folder: its agents use worktrees
   * whatever the person's setting says. False for a terminal the runner doesn't have.
   */
  isTours(terminalId: string): boolean {
    try {
      return withinFolder(
        this.host.cwdOf(terminalId),
        tourFolder(this.host.home),
        this.host.platform,
      )
    } catch {
      return false
    }
  }

  // Only the tour's own terminals, those in its folder, are rung; one elsewhere is a
  // `CONFLICT`, as is one whose agent hasn't shown yet.
  private ring(terminalId: string, line: string): void {
    const cwd = this.host.cwdOf(terminalId)
    if (!withinFolder(cwd, tourFolder(this.host.home), this.host.platform))
      throw new DomainError("CONFLICT", "The terminal isn't one of the tour's.")
    if (!this.host.notice(terminalId, line))
      throw new DomainError("CONFLICT", "The terminal's agent hasn't started yet.")
  }
}

// The agent as a teammate on its cheapest model, or none where that can't be told.
const teammate = (agent: AgentName, models: readonly Model[]): Teammate | undefined => {
  const { model, effort } = tourChoice(agent, models)
  return model === undefined ? undefined : { agent, model, ...(effort !== undefined && { effort }) }
}

/**
 * Whether `path` is `folder` or inside it. Windows' and macOS' file systems don't tell cases
 * apart (macOS' as installed), so neither does this there.
 */
export const withinFolder = (
  path: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const paths = platform === "win32" ? win32 : posix
  const fold = (text: string) =>
    platform === "win32" || platform === "darwin" ? text.toLowerCase() : text
  const inner = paths.relative(fold(paths.resolve(folder)), fold(paths.resolve(path)))
  return inner === "" || (inner.split(paths.sep)[0] !== ".." && !paths.isAbsolute(inner))
}
