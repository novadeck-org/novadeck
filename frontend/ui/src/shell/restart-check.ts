import { shellCommandLine, terminalPhase } from "@novadeck/core/terminals/ending"
import { isAgentProgram, isShellProcess, runsAgentCommand } from "@novadeck/core/terminals/process"
import type { TerminalMetadata } from "@novadeck/core/types"

// What a restart for an update does to the workspace, terminal by terminal.
// - `resume`: an agent mid-turn, or one waiting on background work or a wake-up it set: the
//   runner resumes it at once (its turn is cut, which its notice tells it). An agent held on
//   a dialog that waits for the person, idle, paused or asleep has no turn cut: it reopens
//   (asleep until seen).
// - `reopen`: every other terminal that keeps its place: a shell at its prompt, a terminal
//   still starting. It reopens in its folder.
// - `risks`, what does not come back, each by terminal:
//   - `stops`: a program run in a plain shell; the person starts it again. `command` is its
//     command line.
//   - `agent`: work an agent started and waits on (commands, background tasks, subagents),
//     which the restart stops; the agent itself resumes.
//   - `unknown`: a shell the runner says holds work (a background or suspended job, a line
//     not finished, a program the platform can't name, as on Windows) whose command isn't
//     known, so nothing can be promised about it.
// A terminal with a risk still reopens or resumes, and counts there too. Ended terminals
// (exited, failed) are left out: there is nothing in them to come back.
export type Risk =
  | {
      readonly kind: "stops"
      readonly id: string
      readonly title: string
      readonly command: string
    }
  | {
      readonly kind: "agent"
      readonly id: string
      readonly title: string
      // The one command it waits on, when it is one; else `what` says it in words.
      readonly command?: string
      readonly what: string
      // All of it is a command the person ran in its agent's shell mode, not work it waits on.
      readonly shellOnly?: true
    }
  | { readonly kind: "unknown"; readonly id: string; readonly title: string }

export type RestartCheck = {
  readonly resume: number
  readonly reopen: number
  readonly risks: readonly Risk[]
}

// Which terminal's risk of which kind, to tell one the card shows from one it doesn't.
export const riskKey = (risk: Risk): string => `${risk.kind}:${risk.id}`

export const nothingToCheck: RestartCheck = { resume: 0, reopen: 0, risks: [] }

const maxCommand = 40
const maxWords = 4
const interpreters = new Set(["node", "nodejs", "python", "python3", "bun", "deno", "ruby", "perl"])

// "/usr/bin/node", "C:\\x\\node.exe" and "pnpm.cjs" read as "node" and "pnpm".
const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path
const withoutExtension = (name: string): string => name.replace(/\.[^.]+$/, "")
const withoutExe = (name: string): string => name.replace(/\.exe$/i, "")
const scriptFile = /\.(?:[cm]?js|ts|py|rb|pl|sh)$/i

// Package managers' entry scripts, by the name a person types: "pnpm.cjs" is `pnpm`,
// npm's "npm-cli.js" is `npm`. Any other script shows as it is named.
const launchers: ReadonlyMap<string, string> = new Map([
  ["pnpm", "pnpm"],
  ["pnpx", "pnpx"],
  ["npm-cli", "npm"],
  ["npx-cli", "npx"],
  ["yarn", "yarn"],
  ["yarnpkg", "yarn"],
  ["corepack", "corepack"],
])

// `head` and the plain words that follow, to read in a line: they stop at the first word that
// is an option (`-p`), carries a value (`KEY=x`, `user:pass`, `a@b`), or is a path to a file
// that isn't a script, and at four words. Nothing after the first such word is shown, so what
// follows an option, where a secret would be, never is; a script's path shows as its file name.
// Cut at about 40 characters.
const leading = (head: readonly string[], rest: readonly string[]): string => {
  const words = [...head]
  for (const word of rest) {
    if (words.length >= maxWords || word.startsWith("-")) break
    if (/[\\/]/.test(word)) {
      const file = baseName(word)
      if (!scriptFile.test(file)) break
      words.push(file)
    } else if (/[=@:]/.test(word)) break
    else words.push(word)
  }
  const text = words.join(" ")
  return text.length > maxCommand ? `${text.slice(0, maxCommand - 1).trimEnd()}…` : text
}

// The command a program runs as, to read in a line (see `leading`): its program's basename and
// its plain words, "pnpm dev". An interpreter given a script reads as the script when it is a
// known launcher (`node …/pnpm.cjs dev` is `pnpm dev`) and otherwise as the interpreter and the
// script's file name (`python3 manage.py runserver`). The process's own name stands where the
// command line isn't known.
export const commandText = (name: string, argv: readonly string[] | undefined): string => {
  const [program, ...rest] = argv ?? []
  if (program === undefined || program === "") return name
  const first = withoutExe(baseName(program))
  const script = rest[0]
  if (interpreters.has(first.toLowerCase()) && script !== undefined && !script.startsWith("-")) {
    const launcher = launchers.get(withoutExtension(baseName(script)))
    return leading(launcher === undefined ? [first, baseName(script)] : [launcher], rest.slice(1))
  }
  return leading([first], rest)
}

// Words that begin shell syntax rather than name a program: `for i in $(seq 1 60)` names none.
const shellSyntax = new Set(["for", "while", "until", "if", "case", "select", "function", "!"])

// Words that join one command to the next: what follows the first is another command.
const operators = new Set(["&&", "||", ";", "|", "&"])

// A command a person or an agent typed as one string, shown as `commandText` shows one, up to
// its first operator and past a leading `cd <folder> &&`, as agents write them; none where it
// begins with an option or a value, as `KEY=x pnpm dev` does, or with shell syntax (a loop, a
// group, a substitution), which names no program to read.
const commandString = (command: string): string | undefined => {
  let words = command.trim().split(/\s+/)
  while (words[0] === "cd" && words[2] === "&&") words = words.slice(3)
  // `sleep 30; gh …` ends its first command on the word's own `;`.
  const end = words.findIndex((word) => operators.has(word) || word.endsWith(";"))
  if (end !== -1) words = [...words.slice(0, end), words[end]!.replace(/;$/, "")]
  const [program, ...rest] = words.filter((word) => word !== "" && !operators.has(word))
  if (!program || program.startsWith("-") || /[=@:]/.test(baseName(program))) return undefined
  if (shellSyntax.has(program) || /^(?:[[({`]|\$\()/.test(program)) return undefined
  return leading([withoutExe(baseName(program))], rest) || undefined
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`

// What an agent's work that a restart stops says, from the jobs it waits on and the background
// work its harness counts: the one command, or words.
const withoutShellCommand = (terminal: TerminalMetadata): TerminalMetadata => {
  if (terminal.state !== "running" || !terminal.agent?.shellCommand) return terminal
  const { shellCommand: _shellCommand, ...agent } = terminal.agent
  return { ...terminal, agent }
}

const agentWork = (
  terminal: TerminalMetadata,
): { readonly command?: string; readonly what: string; readonly shellOnly?: true } | undefined => {
  if (terminal.state !== "running" || !terminal.agent) return undefined
  const jobs = terminal.agent.waiting?.jobs ?? []
  const { tasks = 0, agents = 0 } = terminal.agent.background ?? {}
  const shell = shellCommandLine(terminal)
  // A command the person ran in its shell mode is counted apart from the work the agent waits on.
  const own = shell === undefined ? 0 : 1
  const commands = Math.max(jobs.length, jobs.length > 0 ? 0 : tasks)
  if (own + commands === 0 && agents === 0) return undefined
  const one =
    own === 1 && commands === 0
      ? shell
      : own === 0 && jobs.length === 1
        ? jobs[0]!.command
        : undefined
  const only = one !== undefined && agents === 0 ? commandString(one) : undefined
  const parts = [
    own > 0 && plural(own, "shell command"),
    commands > 0 && plural(commands, "background command"),
    agents > 0 && plural(agents, "subagent"),
  ].filter((part): part is string => part !== false)
  return {
    ...(only !== undefined ? { command: only } : {}),
    what: `${parts.join(" and ")} ${own + commands + agents === 1 ? "stops" : "stop"}`,
    ...(own > 0 && commands + agents === 0 ? { shellOnly: true as const } : {}),
  }
}

// A terminal runs an agent when its foreground process is a harness's program, or its command
// line runs one (`node …/codex.js`, `npx @anthropic-ai/claude-code`, `pnpm dlx`, `bunx`, by the
// harnesses' own table), or the platform names no process (Windows, or a Node CLI whose command
// line macOS hides) and the agent reported. An `agent` left over from one that quit does not
// count once another program holds the foreground: that program is the terminal's, and it
// stops, as does an editor an agent opened (Claude Code's Ctrl+G), since what is edited is lost.
const runsAgent = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" &&
  (isAgentProgram(terminal.process) ||
    runsAgentCommand(terminal.argv) ||
    (terminal.process === "" && terminal.agent !== undefined))

// What the runner said of the shells that hold work, read when the card opened: those that
// hold it and those it couldn't read.
export type RestartBusy = {
  readonly busy: ReadonlySet<string>
  readonly unknown: ReadonlySet<string>
}

// `busy` is the runner's word on shells, read when the card opened; absent until it answers,
// so only what the roster shows counts. A terminal it names, an agent's included, is a risk
// next to what the roster says of it.
const held = (busy: RestartBusy | undefined, id: string): boolean =>
  busy !== undefined && (busy.busy.has(id) || busy.unknown.has(id))

export const restartCheck = (
  terminals: readonly TerminalMetadata[],
  busy: RestartBusy | undefined = undefined,
  now = Date.now(),
): RestartCheck => {
  let resume = 0
  let reopen = 0
  const risks: Risk[] = []
  for (const terminal of terminals) {
    if (terminal.state === "exited" || terminal.state === "failed") continue
    const { id, name: title } = terminal
    if (runsAgent(terminal)) {
      // A shell command is no turn: the phase counts what the agent's turn does.
      const phase = terminalPhase(withoutShellCommand(terminal), false, now)
      if (phase === "running" || phase === "waiting") resume += 1
      else reopen += 1
      const work = agentWork(terminal)
      if (work) risks.push({ kind: "agent", id, title, ...work })
      // A job of the shell's own beside the agent (`pnpm dev &` typed before it started), or
      // a process under the agent it doesn't report. The runner counts the agent's own
      // background commands there too, so where the agent named its work, that row stands
      // for the terminal, rather than show its own loop again as "Can't see what runs". Work
      // beside what it named (a dev server Claude Code leaves out of its jobs) goes unnamed
      // then, though the terminal still has its row to go to.
      else if (held(busy, id)) risks.push({ kind: "unknown", id, title })
    } else if (terminal.state === "running" && !isShellProcess(terminal.process)) {
      // The roster calls a terminal running only for a program past its shell, so what runs
      // is named here, on every OS that tells.
      risks.push({
        kind: "stops",
        id,
        title,
        command: commandText(terminal.process, terminal.argv),
      })
    } else if (
      (terminal.state === "idle" || terminal.state === "running") &&
      (terminal.busy === true || held(busy, id))
    ) {
      // A shell the roster calls idle, though the runner sees work in it: a job in the
      // background, a suspended program, a program the platform can't name (Windows).
      risks.push({ kind: "unknown", id, title })
    } else {
      reopen += 1
    }
  }
  return { resume, reopen, risks }
}
