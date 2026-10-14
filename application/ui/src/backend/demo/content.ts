import { companionKeyId } from "../../model/companion"
import { gridColumns } from "../../model/layout/grid-placement"
import { viewOf } from "../../model/seed"
import { createTerminalState } from "../../model/state"
import type {
  AgentStatus,
  CanvasLayout,
  GridBreakpoint,
  GridLayouts,
  TerminalMetadata,
  Workspace,
} from "../../model/types"
import type { Backend, BackendSink, CreateBackend, TerminalKey } from "../port"
import { terminalOf } from "./debug/terminals"
import type { DemoSurfaceRuntime } from "./debug/types"
import { createDemoEngine } from "./engine"
import { demoBackend, windowReset, withConversations } from "./index"
import { createDemoMessages, studioMailbox } from "./messages"
import { demoTerminalId, terminalSlot } from "./samples"
import { authAgent, studioAgent, type SampleAgent } from "./showcase/agents"
import { devServerArtifacts } from "./showcase/artifacts"
import { createShowcase } from "./showcase/simulation"
import { showcaseTranscripts } from "./transcripts"
import { demoTurns, type DemoTurns } from "./turns"

// Both sample agents wrote a plan, and wait on the person to approve it.
const planned: AgentStatus = {
  working: true,
  planning: true,
  attention: { kind: "plan", count: 1 },
}

// A UI-only workspace. The previews never start processes or request a runner.
export const contentDemo = (
  runtime?: DemoSurfaceRuntime,
  turns: DemoTurns = demoTurns(),
): Backend => {
  const session = { projectId: "studio", workspaceSessionId: "initial" }
  const terminals: TerminalMetadata[] = [
    {
      id: demoTerminalId(session, 1),
      name: "Build Studio",
      handle: "moth",
      titleSource: { kind: "person" },
      command: "codex",
      process: "codex",
      state: "running",
      directory: "~/projects/studio",
      agent: planned,
    },
    {
      id: demoTerminalId(session, 3),
      name: "Refactor auth",
      handle: "owl",
      ledBy: "moth",
      titleSource: { kind: "agent", by: "moth" },
      command: "claude",
      process: "claude",
      state: "running",
      directory: "~/projects/studio",
      agent: planned,
    },
    {
      id: demoTerminalId(session, 2),
      name: "Dev server",
      handle: "fox",
      titleSource: { kind: "murmur" },
      command: "pnpm dev",
      process: "vite",
      state: "running",
      directory: "~/projects/studio",
    },
  ]
  const website: TerminalMetadata = {
    id: demoTerminalId({ projectId: "website", workspaceSessionId: "website-initial" }, 1),
    name: "Tests",
    handle: "moth",
    titleSource: { kind: "murmur" },
    command: "pnpm test --watch",
    process: "node",
    state: "running",
    directory: "~/projects/website",
  }
  const canvasLayout: CanvasLayout = {
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
  const agents = [
    {
      key: { ...session, terminalId: demoTerminalId(session, 1) },
      handle: "moth",
      sample: studioAgent,
    },
    {
      key: { ...session, terminalId: demoTerminalId(session, 3) },
      handle: "owl",
      sample: authAgent,
    },
  ]
  const showcase = createShowcase({
    agents,
    shown: [
      {
        key: { ...session, terminalId: demoTerminalId(session, 2) },
        handle: "fox",
        artifacts: devServerArtifacts,
      },
    ],
  })
  const agentAt = (key: TerminalKey): SampleAgent | undefined =>
    agents.find((agent) => companionKeyId(agent.key) === companionKeyId(key))?.sample
  const backend = demoBackend(
    createDemoEngine(),
    false,
    (_terminal, key) => agentAt(key)?.transcript,
    runtime,
  )
  let latest: Workspace | undefined
  let reset: BackendSink["dispatch"] | undefined
  // The showcase session's items as they stand, which an agent showing something again
  // finds its own in.
  const current = () =>
    latest?.projects
      .find((project) => project.id === session.projectId)
      ?.history.find((each) => each.id === session.workspaceSessionId)?.state.items ?? []
  const content: Backend = {
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
                name: `Terminal ${terminalSlot(terminalId)}`,
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
                createTerminalState(terminals, "focus", "grid", {
                  canvasLayout,
                  gridLayouts,
                }),
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
  return withConversations(content, showcaseTranscripts(Date.now()), turns, (conversations) => ({
    ...conversations,
    // What the person sends a sample agent, it acts on: it revises its plan, shows
    // something.
    send: async (key, text) => {
      await conversations.send(key, text)
      showcase.told(key, text)
    },
    // Approving a plan is a "y" to its agent; declining it, its words, or an "n", and the
    // agent then comes back with the revised plan to approve. Nothing else is told: only
    // an answer that went through, and only to a plan.
    answer: async (key, request, answer) => {
      const asked = conversations
        .conversation(key)
        .getSnapshot()
        .requests.find((each) => each.id === request)
      await conversations.answer(key, request, answer)
      if (asked?.kind !== "plan" || answer.type !== "choice" || !agentAt(key)) return
      // The plan's last option is the one that keeps planning.
      const options = asked.dialog?.type === "choices" ? asked.dialog.options : []
      if (answer.option !== options.at(-1)?.id) return showcase.told(key, "y")
      // Words that read as approval, or as asking it to show something, are no notes for
      // the plan: it keeps planning, whatever they say. Asking it to re-read the plan goes
      // through, for an agent that applies the notes in it only then.
      const words = answer.text?.trim()
      const notes = words && !/^(?:y|yes)$|^(?:show|open)\b/i.test(words)
      const epoch = turns.epoch(key)
      showcase.told(key, notes ? words : "n", () => {
        // Still at rest where the answer left it: the revised plan waits on the person.
        if (turns.epoch(key) === epoch && !turns.working(key))
          turns.ask(key, terminalOf(latest, key), "plan", 1)
      })
    },
  }))
}

export const createContentDemo: CreateBackend = () => contentDemo()
