import { gridColumns } from "../../model/layout/grid-placement"
import { createTerminalState } from "../../model/state"
import type { CanvasLayout, GridBreakpoint, GridLayouts, TerminalMetadata } from "../../model/types"
import type { CreateBackend } from "../port"
import { createDemoEngine, type DemoEngine } from "./engine"
import { demoBackend } from "./index"
import { authAgent, studioAgent } from "./showcase/agents"
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
  // The sample agents run in the first two terminals: they open with their own
  // transcripts, answer what they're told, and report their plans and what they show.
  const agents = { "01": studioAgent, "03": authAgent }
  const showcase = createShowcase(agents)
  const agentOf = (terminal: TerminalMetadata) => agents[terminal.id as keyof typeof agents]
  const base = createDemoEngine((command, terminal) => agentOf(terminal)?.reply(command.trim()))
  const engine: DemoEngine = {
    ...base,
    run: (key, command) => {
      base.run(key, command)
      if (command.trim()) showcase.told(key.terminalId, command)
    },
  }
  return {
    ...demoBackend(engine, false, (terminal) => agentOf(terminal)?.transcript),
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
