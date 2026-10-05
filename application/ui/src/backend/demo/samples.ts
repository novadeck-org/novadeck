import type { WorkspaceSeed } from "../../model/seed"
import { sessionName } from "../../model/session-name"
import type { CanvasLayout, Project, TerminalMetadata } from "../../model/types"

// The sample transcript a demo terminal opens with, unless an agent runs in it.
export type SampleOutput = "shell" | "server" | "tests" | "git" | "logs" | "build"
// The agents the demo simulates, by program name.
export const demoAgents = { claude: "Claude", codex: "Codex" } as const
export type DemoAgent = keyof typeof demoAgents

export const demoAgent = (terminal: TerminalMetadata): DemoAgent | undefined =>
  Object.hasOwn(demoAgents, terminal.process) ? (terminal.process as DemoAgent) : undefined

const samples: (TerminalMetadata & {
  output: SampleOutput
  x: number
  y: number
  height: number
})[] = [
  {
    id: "01",
    name: "Checkout implementation",
    directory: "~/projects/novadeck",
    command: "zsh",
    state: "running",
    output: "shell",
    process: "zsh",
    x: 80,
    y: 80,
    height: 400,
  },
  {
    id: "02",
    name: "Dev server",
    directory: "~/projects/novadeck/ui",
    command: "pnpm dev",
    state: "running",
    output: "server",
    process: "vite",
    x: 690,
    y: 80,
    height: 310,
  },
  {
    id: "03",
    name: "Tests",
    directory: "~/projects/novadeck/ui",
    command: "pnpm test",
    state: "running",
    output: "tests",
    process: "vitest",
    x: 1300,
    y: 80,
    height: 385,
  },
  {
    id: "04",
    name: "Checkout review",
    directory: "~/projects/novadeck",
    command: "zsh",
    state: "running",
    output: "shell",
    process: "zsh",
    x: 80,
    y: 540,
    height: 330,
  },
  {
    id: "05",
    name: "Runtime",
    directory: "~/projects/novadeck/runtime",
    command: "pnpm dev",
    state: "running",
    output: "logs",
    process: "node",
    x: 690,
    y: 450,
    height: 375,
  },
  {
    id: "06",
    name: "Build",
    directory: "~/projects/novadeck",
    command: "pnpm build",
    state: "finished",
    output: "build",
    process: "vite",
    x: 1300,
    y: 525,
    height: 305,
  },
]

export const terminals: TerminalMetadata[] = samples.map(
  ({ output: _output, x: _x, y: _y, height: _height, ...terminal }) => terminal,
)

const outputs = new Map(samples.map(({ id, output }) => [id, output]))

// Terminals the demo adds open as a plain shell.
export const sampleOutput = (terminal: TerminalMetadata): SampleOutput =>
  outputs.get(terminal.id) ?? "shell"

export const demoCanvasLayout = (): CanvasLayout => ({
  minimized: {},
  geometry: Object.fromEntries(
    samples.map(({ id, x, y, height }) => [
      id,
      {
        position: { x, y },
        width: 550,
        height,
      },
    ]),
  ),
})

export const initialProjects: Project[] = [
  { id: "storefront", name: "storefront", directory: "~/projects/storefront" },
  { id: "api-service", name: "api-service", directory: "~/projects/api-service" },
]

export const projectTerminals = (project: Project, agents = false): TerminalMetadata[] =>
  terminals.map((terminal) => ({
    ...terminal,
    directory: terminal.directory.replace(/^~\/projects\/[^/]+/, project.directory),
    // Claude Code planned, and waits for the person to review the plan.
    ...(agents && terminal.id === "01"
      ? {
          command: "claude",
          process: "claude",
          state: "running" as const,
          agent: {
            working: true,
            planning: true as const,
            attention: { kind: "plan" as const, count: 1 },
          },
        }
      : {}),
    // Codex waits for the person to allow a command while two of its subagents explore,
    // as an agent's hooks report it.
    ...(agents && terminal.id === "04"
      ? {
          command: "codex",
          process: "codex",
          state: "running" as const,
          agent: {
            working: true,
            attention: { kind: "permission" as const, count: 1 },
            subagents: [
              { id: "demo-explorer-1", type: "explorer" },
              { id: "demo-explorer-2", type: "explorer" },
            ],
            usage: {
              context: { occupied: 30_000, capacity: 200_000 },
              limits: [{ minutes: 300, used: 0.4, resetsAt: null }],
            },
          },
        }
      : {}),
    // Claude Code's turn is over, but the subagents it started in the background, which
    // wake it once done, still run, beside a command: it works on.
    ...(agents && terminal.id === "03"
      ? {
          command: "claude",
          process: "claude",
          state: "running" as const,
          agent: {
            working: true,
            background: { agents: 2, tasks: 1 },
            subagents: [
              { id: "demo-tester-1", type: "general-purpose" },
              { id: "demo-tester-2", type: "general-purpose" },
            ],
          },
        }
      : {}),
    // Claude Code's turn is over, a command it started still running, as a dev server
    // may for ever: it shows, but keeps nothing working.
    ...(agents && terminal.id === "06"
      ? {
          command: "claude",
          process: "claude",
          state: "running" as const,
          agent: { working: false, background: { agents: 0, tasks: 1 } },
        }
      : {}),
    // Antigravity runs where Novadeck hears nothing from it, as its hooks aren't connected.
    ...(agents && terminal.id === "05"
      ? { command: "agy", process: "agy", state: "running" as const }
      : {}),
  }))

// Each sample project opens one session with the stable ID "initial".
export const demoSeed = (now: number, agents = false): WorkspaceSeed => ({
  projects: initialProjects.map((project) => ({
    ...project,
    sessions: [
      {
        id: "initial",
        name: sessionName(now),
        terminals: projectTerminals(project, agents),
        items: [],
        windows: [],
        canvasLayout: demoCanvasLayout(),
      },
    ],
  })),
})

export const createMockTerminal = (number: number, directory: string): TerminalMetadata => {
  const id = String(number).padStart(2, "0")
  return {
    id,
    name: `Terminal ${id}`,
    directory,
    command: "zsh",
    process: "zsh",
    state: "idle",
  }
}

export const mockReply = (command: string, terminal: TerminalMetadata): string => {
  const input = command.trim()
  if (input === "help")
    return "Local demo commands: help, pwd, ls, whoami, date, echo <text>, clear"
  if (input === "pwd") return terminal.directory.replace("~", "/Users/alex")
  if (input === "ls")
    return "application/   node_modules/   package.json   pnpm-lock.yaml   README.md"
  if (input === "whoami") return "alex"
  if (input === "date") return new Date().toLocaleString()
  if (input === "echo") return ""
  if (input.startsWith("echo ")) return input.slice(5)
  if (demoAgent(terminal))
    return "This is a mock AI session. Your message is saved here, but no model is connected."
  return `Preview shell: “${input}” isn't connected to a process. Type help to explore.`
}
