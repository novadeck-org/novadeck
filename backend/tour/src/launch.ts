import type { Effort } from "@novadeck/harness-core/harness"
import { commandLine } from "@novadeck/harness-core/prompts"
import { novaProgram } from "@novadeck/harness-nova/launcher"
import { novaDefaultModel } from "@novadeck/harness-nova/model"
import { pi } from "@novadeck/harness-pi/index"
import type { AgentName } from "@novadeck/protocol"

/**
 * The agent the tour always runs: Nova (the owner's decision, 2026-11-25, after
 * opencode from 2026-11-23), which Novadeck downloads itself (the runner's harnesses/nova.ts), on GPT-6
 * Luna at medium effort through Novadeck's model service, paid for by Novadeck. The person's own
 * agents, accounts and model lists play no part, so nothing of the tour is spent from them, and
 * nothing need be installed or connected.
 */
export const tourAgent = "pi" satisfies AgentName
export const tourModel = novaDefaultModel
export const tourEffort: Effort = "medium"

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
 * may hold behind its startup screens. It starts Nova by its word (`novaProgram`),
 * which the terminal's shell runs as its launcher; the model and effort are on the line, and the
 * launcher gives it Nova's model service, as it does every Nova.
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
