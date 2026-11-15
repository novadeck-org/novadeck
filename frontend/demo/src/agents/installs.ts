import type { AgentName } from "@novadeck/core/harnesses"
import type { AgentConnection, Backend, BackendSink, TerminalKey } from "@novadeck/core/port"
import { createStore, type Store } from "@novadeck/core/store"
import { terminalKeyId } from "@novadeck/core/terminals/registry"

// What the runner says installs each agent on macOS and Linux, which the demo shows as it
// would be run; nothing here installs anything.
export const demoInstallers: Readonly<Record<AgentName, string>> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  agy: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
}

// The agent a command installs, where it is one of those above.
export const installedBy = (command: string | undefined): AgentName | undefined =>
  (Object.keys(demoInstallers) as AgentName[]).find((agent) => demoInstallers[agent] === command)

// An agent the demo does not have installed, as the runner lists one: with its installer.
export const missingAgent = (agent: AgentName): AgentConnection => ({
  agent,
  available: false,
  connected: false,
  busy: false,
  installer: demoInstallers[agent],
})

const downloads: Readonly<Record<AgentName, readonly string[]>> = {
  claude: [
    "Setting up Claude Code...",
    "Downloading claude-2.1.325-darwin-arm64 ... 100%",
    "Verifying checksum ... ok",
    "Installed to ~/.local/bin/claude",
  ],
  codex: [
    "==> Installing Codex CLI",
    "==> Downloading release 0.169.0 for aarch64-apple-darwin",
    "==> Installed to ~/.local/bin/codex",
    "==> PATH was updated in ~/.zshrc",
  ],
  agy: [
    "Downloading Antigravity CLI for darwin-arm64...",
    "Verifying signature ... ok",
    "Installed agy to ~/.local/bin/agy",
  ],
}

// What the installer prints in the terminal, as it ends: well, or with the error a machine
// without a network gives.
export const installReply = (agent: AgentName, outcome: "installed" | "failed"): string =>
  outcome === "installed"
    ? [...downloads[agent], "", `Done. Run \`${agent}\` to sign in.`].join("\n")
    : `curl: (6) Could not resolve host: ${new URL(demoInstallers[agent].split(" ")[2] ?? "https://x.dev").host}`

// The installs the demo plays, each as a terminal's: whether it ends well. A terminal's screen
// reads it to print what an install prints.
const outcomes = new Map<string, "installed" | "failed">()

export const installOutcome = (key: TerminalKey): "installed" | "failed" | undefined =>
  outcomes.get(terminalKeyId(key))

// How long a played install runs before it ends.
export const installMs = 2_500

export type DemoInstalls = {
  // The backend, whose terminals opened with an agent's installer play it: busy a while, then
  // the agent shows installed or, once armed to fail, still not.
  readonly wrap: (backend: Backend) => Backend
  // Makes every agent not installed again, as on a computer with none of them.
  readonly reset: () => void
  // The next install ends in an error, and the agent stays not installed.
  readonly failNext: () => void
  // The next install does not end until `release`.
  readonly holdNext: () => void
  // Ends the installs held, as they would have.
  readonly release: () => void
}

type Connections = readonly AgentConnection[]

export const createDemoInstalls = (): DemoInstalls => {
  let failing = false
  let holding = false
  // The installs under way, each with how to end it, and the timers that end them.
  const running = new Set<() => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let sink: BackendSink | undefined
  // The agents installs have installed since, which show as available over what the backend's
  // own list says.
  const installed = createStore<ReadonlySet<AgentName>>(new Set())
  const overlaid = (base: Store<Connections>): Store<Connections> => {
    let last: { list: Connections; set: ReadonlySet<AgentName>; shown: Connections } | undefined
    return {
      getSnapshot: () => {
        const list = base.getSnapshot()
        const set = installed.getSnapshot()
        if (last?.list === list && last.set === set) return last.shown
        const shown =
          set.size === 0
            ? list
            : list.map(({ installer: _installer, ...each }) =>
                set.has(each.agent)
                  ? { ...each, available: true }
                  : { ...each, ...(_installer !== undefined && { installer: _installer }) },
              )
        last = { list, set, shown }
        return shown
      },
      subscribe: (listener) => {
        const stops = [base.subscribe(listener), installed.subscribe(listener)]
        return () => stops.forEach((stop) => stop())
      },
    }
  }
  return {
    reset: () => {
      installed.update(() => new Set())
    },
    failNext: () => {
      failing = true
    },
    holdNext: () => {
      holding = true
    },
    release: () => {
      for (const end of running) end()
    },
    wrap: (backend) => {
      const agents = backend.agents && { ...backend.agents, state: overlaid(backend.agents.state) }
      return {
        ...backend,
        ...(agents && { agents }),
        newTerminal: (input) => {
          const terminal = backend.newTerminal(input)
          const agent = installedBy(input.launch?.command)
          const missing = agents?.state
            .getSnapshot()
            .some((each) => each.agent === agent && !each.available)
          if (!agent || !missing) return terminal
          const outcome = failing ? "failed" : "installed"
          const hold = holding
          failing = false
          holding = false
          outcomes.set(terminalKeyId({ ...input.target, terminalId: terminal.id }), outcome)
          const end = (): void => {
            if (timer !== undefined) timers.delete(timer)
            clearTimeout(timer)
            running.delete(end)
            sink?.dispatch([
              {
                type: "terminal/status",
                target: input.target,
                terminalId: terminal.id,
                status: { state: "idle" },
              },
            ])
            if (outcome === "installed") installed.update((set) => new Set(set).add(agent))
          }
          const timer = hold ? undefined : setTimeout(end, installMs)
          if (timer !== undefined) timers.add(timer)
          running.add(end)
          // The installer runs from the first prompt, as the runner's does: a program in the
          // shell, which is what the demo's history reads as busy.
          return {
            id: terminal.id,
            name: terminal.name,
            directory: terminal.directory,
            command: terminal.command,
            process: terminal.process,
            ...(terminal.handle !== undefined && { handle: terminal.handle }),
            state: "running",
          }
        },
        start: (next) => {
          sink = next
          const stop = backend.start?.(next)
          return () => {
            timers.forEach(clearTimeout)
            timers.clear()
            running.clear()
            if (sink === next) sink = undefined
            stop?.()
          }
        },
      }
    },
  }
}
