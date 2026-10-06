import { companionKeyId } from "../../model/companion"
import { gridColumns } from "../../model/layout/grid-placement"
import { viewOf } from "../../model/seed"
import { createTerminalState } from "../../model/state"
import type {
  CanvasLayout,
  GridBreakpoint,
  GridLayouts,
  TerminalMetadata,
  Workspace,
} from "../../model/types"
import type { Backend, BackendSink, CreateBackend, TerminalKey } from "../port"
import type { DemoSurfaceRuntime } from "./debug/types"
import { createDemoEngine, type DemoEngine } from "./engine"
import { demoBackend, windowReset } from "./index"
import { createDemoMessages, studioMailbox } from "./messages"
import { authAgent, studioAgent, type SampleAgent } from "./showcase/agents"
import { devServerArtifacts } from "./showcase/artifacts"
import { createShowcase } from "./showcase/simulation"

// A UI-only workspace. The previews never start processes or request a runner.
export const contentDemo = (runtime?: DemoSurfaceRuntime): Backend => {
  const terminals: TerminalMetadata[] = [
    {
      id: "01",
      name: "Build Studio",
      handle: "t1",
      titleSource: { kind: "person" },
      command: "codex",
      process: "codex",
      state: "running",
      directory: "~/projects/studio",
    },
    {
      id: "03",
      name: "Refactor auth",
      handle: "t3",
      titleSource: { kind: "agent", by: "t1" },
      command: "claude",
      process: "claude",
      state: "running",
      directory: "~/projects/studio",
    },
    {
      id: "02",
      name: "Dev server",
      handle: "t2",
      titleSource: { kind: "fallback" },
      command: "pnpm dev",
      process: "vite",
      state: "running",
      directory: "~/projects/studio",
    },
  ]
  const website: TerminalMetadata = {
    id: "01",
    name: "Tests",
    handle: "t1",
    titleSource: { kind: "fallback" },
    command: "pnpm test --watch",
    process: "node",
    state: "running",
    directory: "~/projects/website",
  }
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
  // plans and what they show. The dev server's terminal holds what can't show, one of
  // each reason.
  const session = { projectId: "studio", workspaceSessionId: "initial" }
  const agents = [
    { key: { ...session, terminalId: "01" }, handle: "t1", sample: studioAgent },
    { key: { ...session, terminalId: "03" }, handle: "t3", sample: authAgent },
  ]
  const showcase = createShowcase({
    agents,
    shown: [{ key: { ...session, terminalId: "02" }, handle: "t2", artifacts: devServerArtifacts }],
  })
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
  const backend = demoBackend(engine, false, (_terminal, key) => agentAt(key)?.transcript, runtime)
  let latest: Workspace | undefined
  let reset: BackendSink["dispatch"] | undefined
  // The showcase session's items as they stand, which an agent showing something again
  // finds its own in.
  const current = () =>
    latest?.projects
      .find((project) => project.id === session.projectId)
      ?.history.find((each) => each.id === session.workspaceSessionId)?.state.items ?? []
  return {
    ...backend,
    // A closed terminal's agent is gone.
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
      for (const action of actions)
        if (action.type === "terminal/close")
          showcase.closed({ ...action.target, terminalId: action.terminalId })
    },
    start: (sink) => {
      reset = sink.dispatch
      const stop = showcase.start(sink.dispatch, current)
      return () => {
        if (reset === sink.dispatch) reset = undefined
        stop()
      }
    },
    // A window's name goes back to what it shows, a terminal's to its default.
    resetTitle: (key) => {
      const { projectId, workspaceSessionId, terminalId } = key
      const window = windowReset(latest, key)
      reset?.(
        window.length
          ? window
          : [
              {
                type: "terminal/update",
                target: { projectId, workspaceSessionId },
                terminalId,
                name: `Terminal ${terminalId}`,
                titleSource: { kind: "default" },
              },
            ],
      )
    },
    companions: showcase,
    messages: createDemoMessages([studioMailbox(Date.now(), session)]),
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
              items: showcase.items,
              windows: [],
              restored: viewOf(
                createTerminalState(terminals, "focus", "grid", { canvasLayout, gridLayouts }),
              ),
            },
          ],
        },
        // A second project, so the switcher has one to switch to and to remove.
        {
          id: "website",
          name: "website",
          directory: "~/projects/website",
          sessions: [
            {
              id: "website-initial",
              name: "Main",
              terminals: [website],
              items: [],
              windows: [],
              restored: viewOf(createTerminalState([website], "focus", "grid")),
            },
          ],
        },
      ],
    },
  }
}

export const createContentDemo: CreateBackend = () => contentDemo()
