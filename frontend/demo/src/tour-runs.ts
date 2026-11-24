import type { AgentName } from "@novadeck/core/harnesses"
import type { TourRun } from "@novadeck/core/port"

const startLine = "Start the Novadeck tour: follow AGENTS.md in this folder."

// The launch lines of each harness's scripted agent, which the demo's other states still play
// (a terminal that starts one); the tour's own run is opencode's alone (`demoTourRun`), as the
// runner's is (backend/runner/src/tour/launch.ts).
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
  opencode: {
    command: "opencode --model openrouter/openai/gpt-6-luna --variant medium --agent build",
    brief: "doorbell",
    model: "openrouter/openai/gpt-6-luna",
  },
  pi: {
    command: `pi --model openai/gpt-6-luna --thinking low "${startLine}"`,
    brief: "launch",
    model: "openai/gpt-6-luna",
  },
}

export const demoRun = (agent: AgentName): Omit<TourRun, "directory" | "removed" | "page"> =>
  launches[agent]

// Why the demo's tour won't start, where the debug panel says it shouldn't: as a runner
// refuses one (a folder of the person's own in its place), with the sentence it gives.
export const demoTourRefusal =
  "~/.novadeck/tour holds files Novadeck didn't put there, so the tour leaves it as it is. Move or remove that folder to take the tour."

// The refusal a failing start gives: the folder's, or the tour's service having no free run to give
// (its own sentence, which the runner passes on as it is).
export const demoRefusal = (how: "folder" | "tickets"): Error =>
  how === "folder"
    ? new Error(demoTourRefusal)
    : new Error("You've taken today's free tours. Try again tomorrow.")
