import type { Effort } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { commandLine } from "../terminals/commands.js"

/**
 * The agent the tour always runs: opencode (the owner's decision, 2026-11-23), on GPT-6 Luna at
 * medium effort, paid for by Novadeck. The person's own agents, accounts and model lists play no
 * part, so nothing of the tour is spent from them.
 */
export const tourAgent = "opencode" satisfies AgentName
export const tourModel = "openrouter/openai/gpt-6-luna"
export const tourEffort: Effort = "medium"

/**
 * The configuration the tour's opencode runs on, for each launch only, in `NOVADECK_OPENCODE_CONFIG`
 * (which Novadeck's plugin merges over the loaded configuration, harnesses/opencode/src/plugin-source.ts;
 * the person's files are never written): the `openrouter` provider pointed at Novadeck's service,
 * with the run's ticket as its key, and the model for its sessions, titles (`small_model`) and
 * both agents it starts as (`build`, `plan`), with the effort as their variant, which opencode
 * takes from an agent only where the agent's model is the session's (session/prompt.ts, 1.19.6).
 * `enabled_providers` and `disabled_providers` are set too, as arrays replace the person's own:
 * the tour can't be left without its provider by their list, and spends nothing through another.
 *
 * Probed 2026-11-23 against the real opencode (1.2.10 on this machine) and a local OpenAI-compatible
 * server, with this configuration as `OPENCODE_CONFIG_CONTENT`: opencode calls
 * `POST <baseURL>/chat/completions` (so `/tour/v1/chat/completions`, never `/responses`) with
 * `Authorization: Bearer <apiKey>` and `"model": "openai/gpt-6-luna"` (the `openrouter/` prefix is
 * opencode's provider id), the effort in the main call as `"reasoning": {"effort": "medium"}`, and a
 * title call to the `small_model` with `"reasoningEffort": "minimal"` beside it.
 */
export const tourConfig = (endpoint: string, ticket: string): string => {
  const agent = { model: tourModel, variant: tourEffort }
  return JSON.stringify({
    provider: { openrouter: { options: { baseURL: endpoint, apiKey: ticket } } },
    enabled_providers: ["openrouter"],
    disabled_providers: [],
    model: tourModel,
    small_model: tourModel,
    agent: { build: agent, plan: agent },
  })
}

/**
 * The flag that lets the tour's agent write files in its own folder without asking, for this
 * launch only: the lead writes the page the tour shows, and the one question the tour wants
 * the person to answer is a teammate's, not a permission. It touches none of the person's
 * settings: opencode's build agent edits without asking unless the person's rules say so, and
 * its plan agent may not edit at all.
 */
export const tourWrites: readonly string[] = ["--agent", "build"]

/**
 * How the tour starts its agent: the command line, with no prompt on it: the lead's brief is
 * rung by the doorbell once its prompt shows and its tools are listed (`doorbell`, as
 * `tour.brief` does), so the agent's own first prompt is Novadeck's notice, not a line a harness
 * may hold behind its startup screens. The model and effort are on the line (Novadeck's shim
 * strips the effort and gives it as the agents' variant), and the provider is the
 * configuration's (`tourConfig`), which the terminals of the tour's folder get in their
 * environment (`Tour.launchEnv`).
 */
export type TourLaunch = {
  readonly command: string
  readonly brief: "doorbell"
  readonly model: string
}

export const tourLaunch = (): TourLaunch => {
  const { launch } = harnesses[tourAgent]
  const [program = "", ...rest] = launch.start
  // Its options right after the program, as `open_agent` puts them.
  const command = commandLine([
    program,
    ...launch.choose({ model: tourModel, effort: tourEffort }),
    ...tourWrites,
    ...rest,
  ])
  return { command, brief: "doorbell", model: tourModel }
}
