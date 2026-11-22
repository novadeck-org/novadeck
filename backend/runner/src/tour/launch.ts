import type { Choice, Model } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { commandLine } from "../terminals/commands.js"

/**
 * The model each harness runs the tour on: its cheapest, which the person agreed to spend on
 * it. Claude Code's and Antigravity's lists are Novadeck's own, so their pick is always there;
 * Codex lists what its account offers, newest first, so the tour takes its first "luna"
 * (OpenAI's fast, affordable tier), or else the last it lists, its oldest.
 */
const cheapest: Readonly<Record<AgentName, (models: readonly Model[]) => Model | undefined>> = {
  claude: (models) => models.find(({ id }) => id === "haiku"),
  codex: (models) => models.find(({ id }) => id.endsWith("-luna")) ?? models.at(-1),
  agy: (models) => models.find(({ id }) => id === "gemini-3.8-flash-low"),
  // One of opencode's own free models where its list holds one (`opencode/<name>-free`), which
  // spends nothing of the person's; else none, and `Tour.ready` refuses the tour (MODELS_UNLISTED)
  // before anything is removed or started: the tour never runs on the person's own default model.
  opencode: (models) => models.find(({ id }) => /^opencode\/.+-free$/.test(id)),
}

/** The cheapest model of `models` for `agent`, at the least effort it takes; none if none fits. */
export const tourChoice = (agent: AgentName, models: readonly Model[]): Choice => {
  const model = cheapest[agent](models)
  if (!model) return {}
  const [effort] = model.efforts
  return { model: model.id, ...(effort !== undefined && { effort }) }
}

/**
 * The flags that let the tour's agent write files in its own folder without asking, for this
 * launch only: the lead writes the page the tour shows, and the one question the tour wants
 * the person to answer is a teammate's, not a permission. None of them touches the person's
 * settings, and each also keeps the agent out of a plan mode their settings may start it in.
 * - Claude Code: `--permission-mode acceptEdits`.
 * - Codex: its workspace-write sandbox, asking only where the model asks to go past it.
 * - Antigravity: `--mode accept-edits`.
 * - opencode: its build agent, which edits without asking unless the person's rules say so;
 *   its plan agent may not edit at all.
 */
export const tourWrites: Readonly<Record<AgentName, readonly string[]>> = {
  claude: ["--permission-mode", "acceptEdits"],
  codex: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
  agy: ["--mode", "accept-edits"],
  opencode: ["--agent", "build"],
}

/**
 * How the tour starts its agent: the command line, with no prompt on it for any harness: the
 * lead's brief is rung by the doorbell once its prompt shows and its tools are listed
 * (`doorbell`, as `tour.brief` does), so the agent's own first prompt is Novadeck's notice, not
 * a line a harness may hold behind its startup screens.
 */
export type TourLaunch = {
  readonly command: string
  readonly brief: "doorbell"
  readonly model?: string
}

export const tourLaunch = (
  agent: AgentName,
  place: { readonly models: readonly Model[] },
): TourLaunch => {
  const { launch } = harnesses[agent]
  const choice = tourChoice(agent, place.models)
  const [program = "", ...rest] = launch.start
  // Its options right after the program, as `open_agent` puts them.
  const command = commandLine([program, ...launch.choose(choice), ...tourWrites[agent], ...rest])
  return {
    command,
    brief: "doorbell",
    ...(choice.model !== undefined && { model: choice.model }),
  }
}
