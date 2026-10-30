import { gridColumns } from "@novadeck/core/layout/grid-placement"
import type { Backend, BackendSink, TerminalKey } from "@novadeck/core/port"
import { viewOf } from "@novadeck/core/seed"
import { createTerminalState } from "@novadeck/core/state"
import {
  type AgentStatus,
  type CanvasLayout,
  type GridBreakpoint,
  type GridLayouts,
  type TerminalMetadata,
  type Workspace,
  terminalKeyPath,
} from "@novadeck/core/types"

import { addressParams } from "../address"
import { showcaseTranscripts } from "../agents/transcripts"
import { demoTurns, type DemoTurns } from "../agents/turns"
import { withFeedback } from "../feedback"
import { demoBackend, windowReset, withConversations, withInbox } from "../index"
import { createDemoMessages, studioMessages } from "../messages"
import { defaultName, demoTerminalId } from "../samples"
import { fixedIntro } from "../screen/terminal"
import { createDemoEngine } from "../terminals/engine"
import type { DemoTerminalSetup } from "../terminals/screens"
import { directoryOf, sessionOf, terminalOf } from "../workspace"
import { authAgent, studioAgent, type SampleAgent } from "./agents"
import { devServerArtifacts } from "./artifacts"
import { changesArtifacts } from "./changes"
import { createShowcase, planFaults, type PlanFault } from "./simulation"

// Both sample agents wrote a plan, and wait on the person to approve it.
const planned: AgentStatus = {
  working: true,
  planning: true,
  attention: { kind: "plan", count: 1 },
}

// A UI-only workspace. The previews never start processes or request a runner.
export const showcaseDemo = (
  setup?: DemoTerminalSetup,
  turns: DemoTurns = demoTurns(),
  // Opens with the plan of the Build Studio agent in this fault, as the debug panel's
  // Plan group would put it.
  planFault?: PlanFault,
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
  // each reason, and a change in each shape.
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
  let latest: Workspace | undefined
  const showcase = createShowcase({
    agents,
    directory: (key) => directoryOf(latest, key),
    shown: [
      {
        key: { ...session, terminalId: demoTerminalId(session, 2) },
        handle: "fox",
        artifacts: [...devServerArtifacts, ...changesArtifacts],
      },
    ],
  })
  if (planFault) showcase.fault(agents[0]!.key, planFault)
  const agentAt = (key: TerminalKey): SampleAgent | undefined =>
    agents.find((agent) => terminalKeyPath(agent.key) === terminalKeyPath(key))?.sample
  const transcriptOf = (key: TerminalKey) => {
    const sample = agentAt(key)
    return sample && fixedIntro(sample.transcript)
  }
  const backend = demoBackend(createDemoEngine(), {
    terminals: { ...setup, introOf: (_terminal, key) => transcriptOf(key) },
  })
  let reset: BackendSink["dispatch"] | undefined
  // The showcase session's items as they stand, which an agent showing something again
  // finds its own in.
  const current = () => sessionOf(latest, session)?.state.items ?? []
  const showcased: Backend = {
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
      const stopTerminals = backend.start?.(sink)
      const stop = showcase.start(sink.dispatch, current)
      return () => {
        if (reset === sink.dispatch) reset = undefined
        stop()
        stopTerminals?.()
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
                name: defaultName(terminalOf(latest, key)?.command),
                titleSource: { kind: "default" },
              },
            ],
      )
    },
    companions: showcase,
    messages: createDemoMessages([studioMessages(Date.now(), session)]),
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
              visitedAt: Date.now(),
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
              visitedAt: Date.now() - 20 * 60_000,
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
  const conversing = withConversations(
    showcased,
    showcaseTranscripts(Date.now()),
    turns,
    (conversations) => ({
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
    }),
  )
  return withFeedback(withInbox(conversing, turns), turns)
}

// Specs open the showcase with `&planFault=` one of the debug panel's plan faults, its
// terminals drawn where `terminals` says.
export const createShowcaseDemo = (terminals?: DemoTerminalSetup): Backend => {
  const fault = addressParams().get("planFault")
  return showcaseDemo(
    terminals,
    undefined,
    planFaults.find((each) => each === fault),
  )
}
