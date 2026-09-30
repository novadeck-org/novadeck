import { companionKeyId } from "../../model/companion"
import { gridColumns } from "../../model/layout/grid-placement"
import { createTerminalState } from "../../model/state"
import type { CanvasLayout, GridBreakpoint, GridLayouts, TerminalMetadata } from "../../model/types"
import type { CreateBackend, TerminalKey } from "../port"
import { createDemoEngine, type DemoEngine } from "./engine"
import { demoBackend } from "./index"
import { authAgent, studioAgent, type SampleAgent } from "./showcase/agents"
import { createShowcase } from "./showcase/simulation"

// A UI-only workspace. The previews never start processes or request a runner.
export const createContentDemo: CreateBackend = () => {
  const terminals: TerminalMetadata[] = [
    {
      id: "01",
      name: "Build Studio",
      command: "codex",
      process: "codex",
      state: "running",
      directory: "~/projects/studio",
    },
    {
      id: "03",
      name: "Refactor auth",
      command: "claude",
      process: "claude",
      state: "running",
      directory: "~/projects/studio",
    },
    {
      id: "02",
      name: "Dev server",
      command: "pnpm dev",
      process: "vite",
      state: "running",
      directory: "~/projects/studio",
    },
  ]
  const canvasLayout: CanvasLayout = {
    minimized: {},
    geometry: Object.fromEntries(
      terminals.map((terminal, index) => [
        terminal.id,
        {
          // One column, so a plan attached beside a node covers none of the others.
          position: { x: 40, y: 40 + index * 620 },
          width: 640,
          height: 560,
        },
      ]),
    ),
  }
  const gridLayouts: GridLayouts = Object.fromEntries(
    Object.entries(gridColumns).map(([breakpoint, columns]) => {
      const count = breakpoint === "mobile" ? 1 : 2
      return [
        breakpoint as GridBreakpoint,
        terminals.map((terminal, index) => ({
          i: terminal.id,
          x: (index % count) * (columns / count),
          y: Math.floor(index / count) * 24,
          w: columns / count,
          h: 24,
          minW: 4,
          minH: 10,
        })),
      ]
    }),
  )
  // The sample agents run in the first two terminals of the showcase's own session:
  // they open with their own transcripts, answer what they're told, and report their
  // plans and what they show.
  const session = { projectId: "studio", workspaceSessionId: "initial" }
  const agents = [
    { key: { ...session, terminalId: "01" }, sample: studioAgent },
    { key: { ...session, terminalId: "03" }, sample: authAgent },
  ]
  const showcase = createShowcase(agents)
  const agentAt = (key: TerminalKey): SampleAgent | undefined =>
    agents.find((agent) => companionKeyId(agent.key) === companionKeyId(key))?.sample
  const base = createDemoEngine((command, _terminal, key) => agentAt(key)?.reply(command.trim()))
  const engine: DemoEngine = {
    ...base,
    run: (key, command) => {
      base.run(key, command)
      if (command.trim()) showcase.told(key, command)
    },
  }
  const backend = demoBackend(engine, false, (_terminal, key) => agentAt(key)?.transcript)
  return {
    ...backend,
    // A closed terminal's agent is gone.
    commit: (workspace, actions) => {
      backend.commit(workspace, actions)
      for (const action of actions)
        if (action.type === "terminal/close")
          showcase.closed({ ...action.target, terminalId: action.terminalId })
    },
    companions: showcase,
    seed: {
      projects: [
        {
          id: "studio",
          name: "studio",
          directory: "~/projects/studio",
          sessions: [
            {
              id: "initial",
              name: "Content previews",
              terminals,
              restored: createTerminalState(terminals, "focus", "grid", {
                canvasLayout,
                gridLayouts,
              }),
            },
          ],
        },
      ],
    },
  }
}
