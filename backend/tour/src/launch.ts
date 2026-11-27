import type { Effort } from "@novadeck/harness-core/harness"
import { commandLine } from "@novadeck/harness-core/prompts"
import { novaProgram } from "@novadeck/harness-nova/launcher"
import { ownModel, ownService } from "@novadeck/harness-nova/model"
import { pi } from "@novadeck/harness-pi/index"
import type { AgentName } from "@novadeck/protocol"

/**
 * The agent the tour always runs: Novadeck's own pi (the owner's decision, 2026-11-25, after
 * opencode from 2026-11-23), which Novadeck downloads itself (the runner's harnesses/bundled-pi.ts), on GPT-6
 * Luna at medium effort through Novadeck's model service, paid for by Novadeck. The person's own
 * agents, accounts and model lists play no part, so nothing of the tour is spent from them, and
 * nothing need be installed or connected.
 */
export const tourAgent = "pi" satisfies AgentName
export const tourModel = ownModel
export const tourEffort: Effort = "medium"

/**
 * What a terminal of the tour's folder is given in its environment, for each launch only: the
 * model service's base URL and the run's ticket as its key, in the variables Novadeck's
 * extension registers the service's model from in Nova, Novadeck's own pi (harnesses/nova's
 * model.ts), taking them out of pi's environment before the agent runs anything. Nothing is
 * written: no settings file of pi's, and no command line holds the ticket.
 */
export const tourEnv = (endpoint: string, ticket: string): NodeJS.ProcessEnv => ({
  [ownService.baseUrl]: endpoint,
  [ownService.key]: ticket,
})

/**
 * The flags the tour's agents start with besides the model, for that launch only: none, as pi
 * asks no permission for an edit or a command (it has no such dialog), and the tour's own rules
 * keep its agents from the shell.
 */
export const tourWrites: readonly string[] = []

/**
 * How the tour starts its agent: the command line, with no prompt on it: the lead's brief is
 * rung by the doorbell once its prompt shows and its tools are listed (`doorbell`, as
 * `tour.brief` does), so the agent's own first prompt is Novadeck's notice, not a line a harness
 * may hold behind its startup screens. It starts Novadeck's own pi by its word (`novaProgram`),
 * which the terminal's shell runs as its launcher; the model and effort are on the line, and the
 * service it reaches is the environment's (`tourEnv`), which the terminals of the tour's folder
 * get (`Tour.launchEnv`).
 */
export type TourLaunch = {
  readonly command: string
  readonly brief: "doorbell"
  readonly model: string
}

export const tourLaunch = (): TourLaunch => {
  const { launch } = pi
  const [, ...rest] = launch.start
  // Its options right after the program, as `open_agent` puts them.
  const command = commandLine([
    novaProgram,
    ...launch.choose({ model: tourModel, effort: tourEffort }),
    ...tourWrites,
    ...rest,
  ])
  return { command, brief: "doorbell", model: tourModel }
}
