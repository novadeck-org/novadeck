import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { TourNeedsAgent, type TourRun } from "@novadeck/core/port"

const agentName = (agent: AgentName): string =>
  harnesses.find(({ id }) => id === agent)?.name ?? agent

const startLine = "Start the Novadeck tour: follow AGENTS.md in this folder."

// The launch lines the runner builds for each harness (backend/runner/src/tour/launch.ts),
// on each one's cheapest model.
const launches: Readonly<Record<AgentName, Omit<TourRun, "directory" | "removed" | "page">>> = {
  claude: {
    command: `claude --model haiku --effort low --permission-mode acceptEdits "${startLine}"`,
    brief: "launch",
    model: "haiku",
  },
  codex: {
    command: `codex --model gpt-6-luna -c model_reasoning_effort=low --sandbox workspace-write --ask-for-approval on-request "${startLine}"`,
    brief: "launch",
    model: "gpt-6-luna",
  },
  agy: {
    command: "agy --model gemini-3.8-flash-low --effort low --mode accept-edits",
    brief: "doorbell",
    model: "gemini-3.8-flash-low",
  },
}

export const demoRun = (agent: AgentName): Omit<TourRun, "directory" | "removed" | "page"> =>
  launches[agent]

// Why the demo's tour won't start, where the debug panel says it shouldn't: as a runner
// refuses one (a folder of the person's own in its place), with the sentence it gives.
export const demoTourRefusal =
  "~/.novadeck/tour holds files Novadeck didn't put there, so the tour leaves it as it is. Move or remove that folder to take the tour."

// The refusal a failing start gives: the folder's, or the agent's that hasn't listed its models.
export const demoRefusal = (how: "folder" | "unlisted", agent: AgentName): Error =>
  how === "folder"
    ? new Error(demoTourRefusal)
    : new TourNeedsAgent(
        `${agentName(agent)} hasn't listed its models here yet, so the tour can't pick its cheapest. Start ${agentName(agent)} and sign in, then take the tour.`,
        agent,
      )
