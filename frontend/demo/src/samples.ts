import type { WorkspaceSeed } from "@novadeck/core/seed"
import { sessionName } from "@novadeck/core/session-name"
import { noTelemetry, setUsage, type Telemetry } from "@novadeck/core/telemetry"
import type {
  AgentStatus,
  CanvasLayout,
  Project,
  TerminalMetadata,
  WorkspaceTarget,
} from "@novadeck/core/types"

import { demoHandle } from "./handles"

// A demo terminal's ID, unique across the whole workspace as the runner's are: the
// session it belongs to, then its number there. The name and handle come from the number.
export const demoTerminalId = (
  { projectId, workspaceSessionId }: WorkspaceTarget,
  number: number,
): string => `${projectId}-${workspaceSessionId}-${String(number).padStart(2, "0")}`

// The terminal's number in its session, as `"01"`: what the sample content, names and
// handles of the demo go by.
export const terminalSlot = (terminalId: string): string =>
  terminalId.slice(terminalId.lastIndexOf("-") + 1)

// Each sample project opens one session with this stable ID.
const initialSession = "initial"

// The sample transcript a demo terminal opens with, unless an agent runs in it.
export type SampleOutput = "shell" | "server" | "tests" | "git" | "logs" | "build"
// The agents the demo simulates, by program name.
export const demoAgents = { claude: "Claude", codex: "Codex" } as const
export type DemoAgent = keyof typeof demoAgents

export const demoAgent = (terminal: TerminalMetadata): DemoAgent | undefined =>
  Object.hasOwn(demoAgents, terminal.process) ? (terminal.process as DemoAgent) : undefined

// The agents whose conversations the demo simulates, by program name: the two it runs
// in its screens, and Antigravity.
export const chatAgents = { ...demoAgents, agy: "Antigravity" } as const
export type ChatAgent = keyof typeof chatAgents

export const chatAgent = (terminal: TerminalMetadata): ChatAgent | undefined =>
  Object.hasOwn(chatAgents, terminal.process) ? (terminal.process as ChatAgent) : undefined

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
  outputs.get(terminalSlot(terminal.id)) ?? "shell"

export const demoCanvasLayout = (projectId: string): CanvasLayout => ({
  geometry: Object.fromEntries(
    samples.map(({ id, x, y, height }) => [
      demoTerminalId({ projectId, workspaceSessionId: initialSession }, Number(id)),
      {
        position: { x, y },
        width: 550,
        height,
      },
    ]),
  ),
})

const sample = (name: string): Project => ({ id: name, name, directory: `~/projects/${name}` })

// The sample projects. In the agents demo the first two run the full set of agents; each
// of the others has one agent in its first terminal, in a state of its own, so the
// switcher shows every mark a project can have (see `projectAgents`); dotfiles runs none.
export const initialProjects: Project[] = [
  sample("storefront"),
  sample("api-service"),
  sample("docs-site"),
  sample("mobile-app"),
  sample("design-system"),
  sample("infra"),
  sample("dotfiles"),
]

const showcased = new Set(["storefront", "api-service"])

// What the agent in each other project's first terminal says as the agents demo opens:
// one asking a question, and ones working; of these, the agents `demoFinishes` names end
// their turn a moment later, for the switcher to mark done or failed until looked at.
const projectAgents: Readonly<Record<string, AgentStatus>> = {
  "docs-site": { working: true, attention: { kind: "question", count: 1 } },
  "mobile-app": { working: true },
  "design-system": { working: true },
  infra: { working: true },
}

// The agents demo's agents that end their turn once it has opened, as one finishing while
// the person looks elsewhere: completed in design-system, failed in infra.
export const demoFinishes: readonly {
  readonly projectId: string
  readonly terminalId: string
  readonly outcome: "completed" | "failed"
}[] = [
  {
    projectId: "design-system",
    terminalId: demoTerminalId(
      { projectId: "design-system", workspaceSessionId: initialSession },
      1,
    ),
    outcome: "completed",
  },
  {
    projectId: "infra",
    terminalId: demoTerminalId({ projectId: "infra", workspaceSessionId: initialSession }, 1),
    outcome: "failed",
  },
]

export const projectTerminals = (project: Project, withAgents = false): TerminalMetadata[] => {
  const agents = withAgents && showcased.has(project.id)
  const single = withAgents ? projectAgents[project.id] : undefined
  return terminals.map((terminal) => ({
    ...terminal,
    id: demoTerminalId(
      { projectId: project.id, workspaceSessionId: initialSession },
      Number(terminal.id),
    ),
    handle: demoHandle(Number(terminal.id)),
    directory: terminal.directory.replace(/^~\/projects\/[^/]+/, project.directory),
    ...(single && terminal.id === "01"
      ? { command: "claude", process: "claude", state: "running" as const, agent: single }
      : {}),
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
    // Claude Code's turn is over, a command it started still running: it keeps nothing
    // working, but waits on the command, which wakes it once it finishes.
    ...(agents && terminal.id === "06"
      ? {
          command: "claude",
          process: "claude",
          state: "running" as const,
          agent: {
            working: false,
            background: { agents: 0, tasks: 1 },
            waiting: {
              jobs: [
                {
                  id: "demo-build",
                  description: "Build the docs site",
                  command: "pnpm --filter docs build",
                  since: Date.now() - 4 * 60_000,
                  until: null,
                },
              ],
              wake: null,
            },
          },
        }
      : {}),
    // Antigravity runs where Novadeck hears nothing from it, as its hooks aren't connected.
    ...(agents && terminal.id === "05"
      ? { command: "agy", process: "agy", state: "running" as const }
      : {}),
  }))
}

// What the agents demo's Claude Code in plan mode and Codex say of their tokens and quotas:
// the first terminal of each showcased project, and its fourth.
export const demoTelemetry = (now: number): Telemetry =>
  [...showcased].reduce((all, projectId) => {
    const session = { projectId, workspaceSessionId: initialSession }
    const context = `${projectId}/${initialSession}`
    return setUsage(
      setUsage(all, context, demoTerminalId(session, 1), {
        context: { occupied: 124_000, capacity: 200_000 },
        limits: [
          { minutes: 300, used: 0.42, resetsAt: now + (2 * 60 + 14) * 60_000 },
          { minutes: 10_080, used: 0.18, resetsAt: now + 3 * 86_400_000 },
        ],
        model: "Opus 5.5",
        effort: null,
      }),
      context,
      demoTerminalId(session, 4),
      {
        context: { occupied: 30_000, capacity: 200_000 },
        limits: [
          { minutes: 300, used: 0.4, resetsAt: now + 48 * 60_000 },
          { minutes: 10_080, used: 0.12, resetsAt: now + 5 * 86_400_000 },
        ],
        model: "gpt-6-astra",
        effort: "high",
      },
    )
  }, noTelemetry)

export const demoSeed = (now: number, agents = false): WorkspaceSeed => ({
  projects: initialProjects.map((project, place) => ({
    ...project,
    sessions: [
      {
        id: initialSession,
        name: sessionName(now),
        visitedAt: now - place * 20 * 60_000,
        terminals: projectTerminals(project, agents),
        items: [],
        windows: [],
        canvasLayout: demoCanvasLayout(project.id),
      },
    ],
  })),
})

// What the runner names a terminal by default (its `defaultTitle`): the program it was
// opened to run, else "Terminal".
// The command a plain demo shell stands for, which names nothing.
export const shellCommand = "zsh"

export const defaultName = (command?: string): string => {
  if (command === shellCommand) return "Terminal"
  const program = command?.trim().split(/\s+/)[0]?.split("/").pop()
  return program || "Terminal"
}

export const createMockTerminal = (
  target: WorkspaceTarget,
  number: number,
  directory: string,
  command?: string,
): TerminalMetadata => {
  const id = demoTerminalId(target, number)
  return {
    id,
    name: defaultName(command),
    handle: demoHandle(number),
    directory,
    command: command ?? shellCommand,
    process: "zsh",
    state: "idle",
  }
}

// Builtins that answer nothing when they work.
const quiet: ReadonlySet<string> = new Set([
  "cd",
  "export",
  "source",
  "alias",
  "unset",
  "set",
  "true",
])

// Everyday commands the demo shell doesn't run, each with a short note instead of an error.
const simulated =
  "This is a simulated shell, so it doesn't run that. In the real app it is your own."
const noted: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "grep",
  "find",
  "mkdir",
  "touch",
  "rm",
  "cp",
  "mv",
  "open",
  "code",
  "vim",
  "nvim",
  "nano",
  "curl",
  "wget",
  "ssh",
  "docker",
  "make",
  "python",
  "python3",
  "pnpm",
  "npm",
  "npx",
  "yarn",
  "bun",
  "node",
  "deno",
  "cargo",
  "go",
  "which",
  "env",
  "history",
  "top",
  "ps",
  "kill",
  "tree",
  "man",
  "exit",
  "logout",
  "sudo",
])

// What the demo's shell answers: a few commands it fakes, a short note for the shell's other
// everyday commands, and, for real nonsense, a line that says it is a simulation and where to
// go, since a person who types into it expects a shell. A program is only matched in a shell:
// an agent's terminal answers any other line as an agent.
export const mockReply = (command: string, terminal: TerminalMetadata): string => {
  const input = command.trim()
  const [program = ""] = input.split(/\s+/)
  if (input === "help")
    return "Local demo commands: help, pwd, ls, whoami, date, echo <text>, git status, claude, clear.\nThis is a simulated shell: the real app runs your own."
  if (input === "pwd") return terminal.directory.replace("~", "/Users/alex")
  if (input === "whoami") return "alex"
  if (input === "date") return new Date().toLocaleString()
  if (input === "echo") return ""
  if (input.startsWith("echo ")) return input.slice(5)
  if (input === "git status")
    return "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean"
  if (demoAgent(terminal))
    return "This is a mock AI session. Your message is saved here, but no model is connected."
  if (program === "ls")
    return "application/   node_modules/   package.json   pnpm-lock.yaml   README.md"
  if (program === "git")
    return "This is a simulated shell, so git only answers `git status`. In the real app it is your own."
  if (program === "claude" || program === "codex")
    return "Agents are simulated here. Open a terminal that is running one and answer what it asks."
  if (quiet.has(program)) return ""
  if (noted.has(program)) return simulated
  return `zsh: command not found: ${program}\nThis is a simulated shell. Type help to see what works, or try ls, git status or claude.`
}
