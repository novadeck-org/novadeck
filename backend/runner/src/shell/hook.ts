import { callFromPayload, isAgyNonCommandTool, maxCommand } from "@novadeck/harness-core/grants"
import type { NotACall, ShellCall } from "@novadeck/harness-core/grants"
import { hookShellSlackMs, dialectPrograms } from "@novadeck/harness-core/hook-command"
import type { Report } from "@novadeck/harness-core/report"
import { agentName, type AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { cut } from "../text.js"
import { object, type Fields } from "./json.js"

/**
 * An agent hook, as the runner takes it from Novadeck's relay (see backend/relay).
 * A connected agent's Novadeck plugin runs the hook launcher, which starts the relay; the
 * relay sends what the hook knows, unread: the event its agent reported, the agent's
 * payload as it came, when the hook started, the processes it runs under and when each
 * started, and what of its environment tells agents apart. The runner reads it here into a report, which the
 * agent's harness decodes (see `harnesses/<id>/src/decode.ts`). A Stop, prompt-time or tool-call
 * hook asks instead, with a deadline: the runner answers what to print, which may deliver
 * agents' messages (see docs/agent-messaging.md). Claude Code's status line runs through
 * the hook in Novadeck's shells, which then shows the person's own, as the relay finds
 * and runs it beside the report.
 */
type RelayHook = {
  readonly report: Omit<Report, "terminalId" | "token">
  /** An ask's or a permission hook's deadline, in epoch milliseconds; absent for a report. */
  readonly deadline?: number
  /**
   * A permission hook's call, read from the genuine payload before it is pruned (a pruned
   * command is cut, and a cut command could match what the whole one never did). The runner
   * answers it at once from the person's grants, apart from asks (see `shell/permissions.ts`).
   */
  readonly permission?: Permission
  /** The command Claude Code's own check refused (PermissionDenied), as the whole payload gave it. */
  readonly denied?: string
}

/** What a permission hook asked, as the payload says, for the runner to decide. */
export type Permission = {
  /** The shell command asked about, or why the payload is none the matcher may judge. */
  readonly call: ShellCall | NotACall
  /**
   * What kind of tool it is: a `shell` command, one of Antigravity's tools known to run
   * none (`plain`), or any other (`other`, which includes a payload that does not parse).
   */
  readonly tool: "shell" | "plain" | "other"
  /**
   * The Bash command the payload names whatever else it holds (an extra field refuses a
   * match, not a retry of a refused command), up to the matcher's limit.
   */
  readonly command: string | null
  /** Claude Code's permission mode (`plan`, `auto`…), where the payload names one. */
  readonly mode: string | null
  /** Whether the terminal was started narrowed (NOVADECK_NARROW). */
  readonly narrow: boolean
  /** The PATH the agent's hook ran under, null where the relay did not give one. */
  readonly path: string | null
  /** A variable of `gitVariables` is set in the hook's environment. */
  readonly gitEnv: boolean
  /** A variable of `ghVariables` is set in the hook's environment. */
  readonly ghEnv: boolean
}

/** Whether Antigravity's tool is one known to run no command (design B3): a closed list. */
const runsNoCommand = (payload: Fields): boolean => {
  const call = payload.toolCall
  const name = object(call) ? call.name : undefined
  return typeof name === "string" && isAgyNonCommandTool(name, object(call) ? call.args : undefined)
}

const readPermission = (
  agent: AgentName,
  event: string,
  payload: Fields,
  narrow: boolean,
  platform: NodeJS.Platform,
  path: string | null,
  env: Fields,
): Permission => {
  const call = callFromPayload(agent, event, payload, platform)
  return {
    call,
    tool:
      typeof call === "object"
        ? "shell"
        : agent === "agy" && runsNoCommand(payload)
          ? "plain"
          : "other",
    command: agent === "agy" ? null : (readDenied(payload) ?? null),
    mode: text(payload.permission_mode, 64) ?? null,
    narrow,
    path,
    gitEnv: gitVariables.some((name) => text(env[name], 65_536) !== undefined),
    ghEnv: ghVariables.some((name) => text(env[name], 65_536) !== undefined),
  }
}

/** The whole command of a refused Bash call, or undefined: nothing is armed from a cut one. */
const readDenied = (payload: Fields): string | undefined => {
  const input = payload.tool_input
  const command = object(input) ? input.command : undefined
  return payload.tool_name === "Bash" &&
    typeof command === "string" &&
    command !== "" &&
    command.length <= maxCommand
    ? command
    : undefined
}

/**
 * The most an ask has from its hook's start. The relay names its own deadline, which the
 * runner keeps to, and this bounds it.
 */
export const askMs = 4_000

/**
 * The variables that redirect or extend a `git push` the runner reads from its own git, which
 * can't see them: configuration, where git looks, how it connects. Set in the hook's environment,
 * the push preset matches nothing. (`GIT_CONFIG_COUNT` stands for its numbered `_KEY_n`/`_VALUE_n`.)
 */
export const gitVariables = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_ASKPASS",
] as const

/**
 * The variables that change the host, repo or configuration of a `gh` call, or a program it
 * runs. Set in the hook's environment, the pr preset matches nothing.
 */
export const ghVariables = [
  "GH_HOST",
  "GH_REPO",
  "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_EDITOR",
  "GH_PAGER",
  "GH_BROWSER",
] as const

/**
 * What of a hook's environment the relay forwards, by name: Claude Code's own pid, and
 * what tells nested agents apart. The relay reads the names from its configuration.
 */
export const hookVariables = [
  "CLAUDE_PID",
  "CURSOR_VERSION",
  "CODEX_THREAD_ID",
  // Set only by Novadeck's Antigravity shim, for a terminal started under the person's grants.
  "NOVADECK_NARROW",
  // The agent's own PATH: a relative or empty entry lets a shell run a same-name program from the
  // call's folder, which no grant may cover (`Permissions`).
  "PATH",
  ...gitVariables,
  ...ghVariables,
] as const

/**
 * The margin an ask leaves before its hook's limit, for the hook to print what a lease
 * delivers and acknowledge it.
 */
const printMs = 500

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value !== "" && value.length <= max ? value : undefined

/** A copy small enough to keep: text past a path's length cut short, deep or wide values dropped. */
export const prune = (value: unknown, depth: number, limit: number): unknown => {
  if (typeof value === "string") return cut(value, limit)
  if (typeof value !== "object" || value === null) return value
  if (depth > 6) return null
  if (Array.isArray(value)) return value.slice(0, 50).map((each) => prune(each, depth + 1, limit))
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, each]) => [key, prune(each, depth + 1, limit)]),
  )
}

// The most a report may hold once pruned: enough for any decoder, as hooks always sent.
const maxReport = 60_000

/**
 * A process the hook runs under, nearest first, where the platform tells: its pid, name,
 * and when it started, in epoch milliseconds, where the relay could read it.
 */
type Ancestor = {
  readonly pid: number
  readonly name: string
  readonly startedAt?: number
}

const ancestorsOf = (value: unknown): Ancestor[] =>
  (Array.isArray(value) ? value : [])
    .slice(0, 8)
    .filter(
      (each): each is Ancestor =>
        object(each) &&
        typeof each.pid === "number" &&
        Number.isSafeInteger(each.pid) &&
        each.pid > 0 &&
        typeof each.name === "string" &&
        (each.startedAt === undefined ||
          (typeof each.startedAt === "number" && Number.isFinite(each.startedAt))),
    )

// The longest a hook's shell may take to start its relay, past which a start read as its
// own is someone else's: well past any cold start.
const maxShellMs = 60_000

// How far after the relay's own start a shell's may read, from clocks read apart: a few
// ticks of Linux's, which counts in hundredths of a second.
const clockSlackMs = 50

/**
 * When the agent fired the hook, where the shell it runs hooks in starts slowly
 * (`hookShellSlackMs`, Windows): when the process it started for the hook began, the
 * ancestor just below the agent's own, or the relay itself where the agent started it
 * directly. Every agent there starts its hook's shell itself, an npm or scoop wrapper
 * around it included. Elsewhere a shell starts at once, so `seq` tells, and the
 * ancestor below the agent may be a long-lived process of its own, as under a wrapper
 * script that doesn't `exec` it. That ancestor counts only where it is a program of the
 * shell the harness runs hooks in (`shells`, `dialectPrograms`), not a wrapper's agent
 * below one carrying the agent's name. Undefined there, and where the agent's process
 * isn't among them, its child's start isn't told, or the start makes no sense for a hook
 * that started at `seq`.
 */
const firedAtOf = (
  instance: string | null,
  seq: number,
  ancestors: readonly Ancestor[],
  shells: readonly string[],
  platform: NodeJS.Platform = process.platform,
): number | undefined => {
  if (hookShellSlackMs(platform) === 0) return undefined
  const index =
    instance === null ? -1 : ancestors.findIndex((each) => String(each.pid) === instance)
  if (index < 0) return undefined
  const shell = index === 0 ? undefined : ancestors[index - 1]
  if (shell !== undefined && !shells.includes(shell.name)) return undefined
  const fired = shell === undefined ? seq : shell.startedAt
  if (fired === undefined || fired > seq + clockSlackMs || seq - fired > maxShellMs)
    return undefined
  return Math.min(fired, seq)
}

/**
 * The agent process that ran the hook: the one its harness's `pidVariable` names, where it
 * sets one, as Claude Code does; else the nearest ancestor with the agent's own name.
 * Unknown where the platform hides it.
 */
const instanceOf = (agent: AgentName, env: Fields, ancestors: Ancestor[]): string | null => {
  const { pidVariable } = harnesses[agent]
  const own = pidVariable === undefined ? undefined : text(env[pidVariable], 10)
  if (own !== undefined) return own
  const found = ancestors.find((each) => each.name === agent)
  return found ? String(found.pid) : null
}

/**
 * Reads a relay's hook, without its sender, which the endpoint checks: undefined for one
 * that isn't a hook of a known agent, or whose payload isn't the JSON object agents send,
 * as the hook then reports nothing.
 */
export const relayHook = (
  value: Fields,
  platform: NodeJS.Platform = process.platform,
): RelayHook | undefined => {
  const agent = agentName.safeParse(value.agent)
  const { seq, payload: sent } = value
  if (!agent.success || typeof seq !== "number" || !Number.isFinite(seq)) return undefined
  if (typeof sent !== "string" || sent.length > 1_000_000) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(sent)
  } catch {
    return undefined
  }
  if (!object(payload)) return undefined
  const env = object(value.env) ? value.env : {}
  const event =
    text(value.event, 64) ??
    (typeof payload.hook_event_name === "string" && payload.hook_event_name.length <= 64
      ? payload.hook_event_name
      : "")
  const ancestors = ancestorsOf(value.ancestors)
  const named = instanceOf(agent.data, env, ancestors)
  const instance = named !== null && /^\d{1,10}$/.test(named) ? named : null
  const codexThread = text(env.CODEX_THREAD_ID, 128)
  const narrow = text(env.NOVADECK_NARROW, 8) === "1"
  const { messaging } = harnesses[agent.data]
  // Read from the genuine payload, before `prune` cuts it.
  // A Codex call on Windows is marked as such, and read in the dialect both its shells agree on.
  const permission =
    event === messaging.permission.event
      ? readPermission(
          agent.data,
          event,
          payload,
          narrow,
          platform,
          text(env.PATH, 65_536) ?? text(env.Path, 65_536) ?? null,
          env,
        )
      : undefined
  const denied = event === messaging.denied ? readDenied(payload) : undefined
  const shells = dialectPrograms[harnesses[agent.data].hookDialect(platform, event)]
  const firedAt = firedAtOf(instance, seq, ancestors, shells, platform)
  const report = {
    agent: agent.data,
    event,
    seq,
    ...(firedAt !== undefined && { firedAt }),
    instance,
    // Only what tells nested agents apart; nothing else of the environment is kept.
    env: {
      cursor: text(env.CURSOR_VERSION, 128) !== undefined,
      ...(codexThread !== undefined && { codexThread }),
      ...(narrow && { narrow: true as const }),
    },
    payload: prune(payload, 0, 4096) as Fields,
  }
  const sized =
    JSON.stringify(report).length <= maxReport
      ? report
      : { ...report, payload: prune(payload, 0, 200) as Fields }
  if (JSON.stringify(sized).length > maxReport) return undefined
  // The runner leases messages only with time left before the relay gives up to print
  // them and acknowledge the lease.
  const { deadline: given } = value
  const relayGivesUp =
    typeof given === "number" && Number.isFinite(given) ? Math.min(given, seq + askMs) : seq + askMs
  const deadline = Math.round(relayGivesUp) - printMs
  if (permission !== undefined) return { report: sized, deadline, permission }
  if (event in messaging.asks) return { report: sized, deadline }
  return denied === undefined ? { report: sized } : { report: sized, denied }
}
