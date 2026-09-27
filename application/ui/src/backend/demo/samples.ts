import type { WorkspaceSeed } from "../../model/seed"
import { sessionName } from "../../model/session-name"
import type { CanvasLayout, Project, TerminalMetadata } from "../../model/types"

const samples: (TerminalMetadata & { x: number; y: number; height: number })[] = [
  {
    id: "01",
    name: "Checkout implementation",
    directory: "~/projects/novadeck",
    command: "claude",
    state: "running",
    kind: "claude",
    process: "claude",
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
    kind: "server",
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
    kind: "tests",
    process: "vitest",
    x: 1300,
    y: 80,
    height: 385,
  },
  {
    id: "04",
    name: "Checkout review",
    directory: "~/projects/novadeck",
    command: "codex",
    state: "running",
    kind: "codex",
    process: "codex",
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
    kind: "logs",
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
    kind: "build",
    process: "vite",
    x: 1300,
    y: 525,
    height: 305,
  },
]

export const terminals: TerminalMetadata[] = samples.map(
  ({ x: _x, y: _y, height: _height, ...terminal }) => terminal,
)

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

export const projectTerminals = (project: Project): TerminalMetadata[] =>
  terminals.map((terminal) => ({
    ...terminal,
    directory: terminal.directory.replace(/^~\/projects\/[^/]+/, project.directory),
  }))

// Each sample project opens one session with the stable ID "initial".
export const demoSeed = (now: number): WorkspaceSeed => ({
  projects: initialProjects.map((project) => ({
    ...project,
    sessions: [
      {
        id: "initial",
        name: sessionName(now),
        terminals: projectTerminals(project),
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
    kind: "shell",
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
  if (terminal.kind === "claude" || terminal.kind === "codex")
    return "This is a mock AI session. Your message is saved here, but no model is connected."
  return `Preview shell: “${input}” isn't connected to a process. Type help to explore.`
}
