import { noTelemetry, setUsage, type Telemetry } from "@novadeck/core/agents/telemetry"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { sessionName } from "@novadeck/core/session-name"
import type { AgentStatus, CanvasLayout, Project, TerminalMetadata } from "@novadeck/core/types"

import { demoHandle } from "../handles"
import { demoTerminalId, terminals as samples } from "../samples"

// The visitor's workspace: a tidy desk, not every state the app can show. Storefront tells
// the story, with Claude Code waiting on its plan, the one thing that asks at the start,
// and Codex quietly reviewing beside a dev server and the tests. The other projects rest,
// for the visitor to look into, and nothing in them asks for attention.

const session = "initial"

// Each sample terminal by its number, as `samples` lists them.
const sample = (slot: string): TerminalMetadata => samples.find((each) => each.id === slot)!

type Placed = TerminalMetadata & { readonly x: number; readonly y: number; readonly height: number }

const sampleProject = (name: string): Project => ({
  id: name,
  name,
  directory: `~/projects/${name}`,
})

// What a project's terminals are, from the samples by number, in its own folder, and where
// they stand on the canvas.
const placed = (
  { id: projectId, directory }: Project,
  slots: readonly {
    readonly slot: string
    readonly name?: string
    readonly command?: string
    readonly process?: string
    // The agent running in it, as its hooks report it.
    readonly agent?: AgentStatus
    readonly x: number
    readonly y: number
    readonly height: number
  }[],
): Placed[] =>
  slots.map(({ slot, agent, ...terminal }) => {
    const base = sample(slot)
    return {
      ...base,
      directory: base.directory.replace(/^~\/projects\/[^/]+/, directory),
      ...terminal,
      ...(agent ? { state: "running" as const, agent } : {}),
      id: demoTerminalId({ projectId, workspaceSessionId: session }, Number(slot)),
      handle: demoHandle(Number(slot)),
    }
  })

// Claude Code in plan mode: asking to have its plan reviewed, or, `reading`, still on its
// way there (see `visitorStory`).
const planning = (reading: boolean) => ({
  working: true,
  planning: true as const,
  ...(reading ? {} : { attention: { kind: "plan" as const, count: 1 } }),
})

// What Claude Code in plan mode says of its tokens and quotas.
export const visitorTelemetry = (now: number): Telemetry =>
  setUsage(
    noTelemetry,
    `storefront/${session}`,
    demoTerminalId({ projectId: "storefront", workspaceSessionId: session }, 1),
    {
      context: { occupied: 124_000, capacity: 200_000 },
      limits: [
        { minutes: 300, used: 0.42, resetsAt: now + (2 * 60 + 14) * 60_000 },
        { minutes: 10_080, used: 0.18, resetsAt: now + 3 * 86_400_000 },
      ],
      model: "Opus 5.5",
      effort: null,
    },
  )

const storefront = sampleProject("storefront")
const apiService = sampleProject("api-service")
const dotfiles = sampleProject("dotfiles")

const desks = (
  reading: boolean,
): readonly { readonly project: Project; readonly terminals: Placed[] }[] => [
  {
    project: storefront,
    terminals: placed(storefront, [
      // Claude Code planned the checkout, and waits for the visitor to review the plan.
      {
        slot: "01",
        command: "claude",
        process: "claude",
        agent: planning(reading),
        x: 80,
        y: 80,
        height: 430,
      },
      { slot: "02", x: 690, y: 80, height: 310 },
      { slot: "03", x: 690, y: 430, height: 330 },
      // Codex reviews the checkout change, and asks nothing yet (see `story`).
      {
        slot: "04",
        command: "codex",
        process: "codex",
        agent: { working: true },
        x: 80,
        y: 570,
        height: 330,
      },
    ]),
  },
  {
    project: apiService,
    terminals: placed(apiService, [
      // An agent at rest, its work done and read.
      {
        slot: "01",
        name: "Rate limiting",
        command: "claude",
        process: "claude",
        agent: { working: false },
        x: 80,
        y: 80,
        height: 430,
      },
      { slot: "02", x: 690, y: 80, height: 310 },
      { slot: "03", x: 690, y: 430, height: 330 },
    ]),
  },
  {
    project: dotfiles,
    terminals: placed(dotfiles, [
      { slot: "01", name: "Terminal", command: "zsh", process: "zsh", x: 80, y: 80, height: 400 },
    ]),
  },
]

const canvasLayout = (terminals: readonly Placed[]): CanvasLayout => ({
  geometry: Object.fromEntries(
    terminals.map(({ id, x, y, height }) => [id, { position: { x, y }, width: 550, height }]),
  ),
})

// `reading` opens Claude Code a few seconds before its plan, which the story then asks for.
export const visitorSeed = (now: number, reading = false): WorkspaceSeed => ({
  projects: desks(reading).map(({ project, terminals }, place) => ({
    ...project,
    sessions: [
      {
        id: session,
        name: sessionName(now),
        visitedAt: now - place * 20 * 60_000,
        terminals: terminals.map(({ x: _x, y: _y, height: _height, ...terminal }) => terminal),
        items: [],
        windows: [],
        canvasLayout: canvasLayout(terminals),
      },
    ],
  })),
})
