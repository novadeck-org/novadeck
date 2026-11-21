import type { AgentMode } from "@novadeck/core/port"

// One way agents may work with each other, as Preferences offers it: its name, when it's the
// right pick, what agents then do, what it costs, and what its map shows, read in its place.
export type AgentModeChoice = {
  readonly mode: AgentMode
  readonly label: string
  readonly lead: string
  readonly facts: readonly string[]
  readonly cost?: string
  readonly map: string
}

// The modes in the order Preferences offers them.
export const agentModeChoices: readonly AgentModeChoice[] = [
  {
    mode: "solo",
    label: "Solo",
    lead: "Best when you run one or two agents and steer each yourself.",
    facts: [
      "Overlaps between agents come to you.",
      "Agents never message or open other agents unless you ask.",
    ],
    map: "@owl and @fern both want port 5173, and each asks you. Agents don't talk to each other.",
  },
  {
    mode: "herd",
    label: "Herd",
    lead: "Best when you run several agents side by side.",
    facts: [
      "Agents settle shared files, ports and CI between them.",
      "You set up teams; opening an agent asks you first.",
    ],
    map: "Agents are linked to each other, and @owl tells @fern it holds port 5173. Nothing reaches you.",
  },
  {
    mode: "swarm",
    label: "Swarm",
    lead: "Best for a big goal you want split up and finished without managing it.",
    facts: [
      "Agents open, lead and close agents without asking.",
      "They decide what you left open instead of waiting.",
    ],
    cost: "More agents running, and more of your usage.",
    map: "@owl leads a team it opened, @wren and @lark. Agents settle things among themselves and report to you.",
  },
]

// The choice of a mode; Herd's for one the list lacks.
export const agentModeChoice = (mode: AgentMode): AgentModeChoice =>
  agentModeChoices.find((choice) => choice.mode === mode) ?? agentModeChoices[1]!
