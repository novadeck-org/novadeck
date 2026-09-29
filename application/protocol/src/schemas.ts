import { z } from "zod"

export const protocolVersion = 1
export const id = z.uuid()
export const name = z.string().trim().min(1).max(200)
export const directory = z.string().min(1).max(4096)
export const columns = z.number().int().min(2).max(500)
export const rows = z.number().int().min(1).max(200)
export const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** The largest incoming WebSocket message a runner accepts; every call must fit in one. */
export const maxWebSocketMessageBytes = 256 * 1024
/**
 * The longest saved session state, in characters. Over WebSocket, the whole
 * `sessions.save` call must also fit in `maxWebSocketMessageBytes`.
 */
export const maxClientStateLength = 196_608

// Opaque client-owned state the runner stores without reading, such as a UI layout.
export const clientState = z.string().max(maxClientStateLength)

export const project = z.strictObject({ id, name, cwd: directory })
export const workspaceSession = z.strictObject({
  id,
  projectId: id,
  name,
  // Last value saved with `sessions.save`, or null before the first save.
  state: clientState.nullable(),
})
// How a shell ended: its exit code, or the signal that killed it (null on Windows),
// and how long it ran, so a client can tell a quick startup failure from a later exit.
export const terminalExit = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  ranMs: z.number().int().nonnegative(),
})

// `name` is the process's own name. `argv` is the foreground process group leader's
// command line, which tells a script apart from its interpreter; null where the
// platform cannot tell and before the runner first looks. The runner truncates both
// to fit.
export const foregroundProcess = z.strictObject({
  name: z.string().max(256),
  argv: z.array(z.string().max(4096)).max(64).nullable(),
})

// Agents whose sessions NovaDeck identifies and can resume once connected: Claude Code,
// Codex and Antigravity. An agent session id is what the agent itself names its
// session: a UUID today, kept to a plain token so a shell can run it as it is.
export const agentName = z.enum(["claude", "codex", "agy"])
export const agentSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

// What the agent holding a terminal's foreground is doing, as its own hooks report it:
// working on a turn, idle between turns, or unknown when they have not said. `attention`
// counts the requests waiting on the person, and names the kind of the oldest one.
export const agentActivity = z.strictObject({
  state: z.enum(["working", "idle", "unknown"]),
  attention: z.strictObject({
    pending: z.number().int().nonnegative(),
    kind: z.enum(["permission", "question"]).nullable(),
  }),
})

export const terminalSummary = z.strictObject({
  id,
  sessionId: id,
  // The shell's current directory as its shell integration last reported it, or where
  // it started; a restart starts there.
  cwd: directory,
  cols: columns,
  rows,
  // Counts the shells this terminal has run: 1 at creation, +1 per restart. A report
  // about an older run is stale.
  run: z.number().int().positive(),
  // How the shell ended; null while it runs.
  exit: terminalExit.nullable(),
  // The terminal's foreground process, such as the shell or a program it runs. Null
  // once exited or when the platform cannot tell.
  process: foregroundProcess.nullable(),
  // The agent that reported a session in this shell since its last prompt, so a client
  // can name the program where the process alone cannot, as on Windows. Null otherwise.
  agent: agentName.nullable(),
  // What that agent is doing; null without one.
  activity: agentActivity.nullable(),
})

// `terminals.watch` events: every terminal's summary, then each later change.
export const terminalChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("changed"), terminal: terminalSummary }),
  z.strictObject({ type: z.literal("removed"), terminalId: id, sessionId: id }),
  // Follows the initial `changed` events: terminals not reported by now do not exist.
  z.strictObject({ type: z.literal("synced") }),
])

const envelope = { terminalId: id, sequence }
export const terminalEvent = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    type: z.literal("snapshot"),
    data: z.string(),
    cols: columns,
    rows,
    // Null while the shell runs.
    exit: terminalExit.nullable(),
  }),
  z.strictObject({ ...envelope, type: z.literal("output"), data: z.string() }),
  z.strictObject({ ...envelope, type: z.literal("resized"), cols: columns, rows }),
  z.strictObject({
    ...envelope,
    type: z.literal("exited"),
    exit: terminalExit,
  }),
])

/** Wire-only marker: the attachment is established and holds the reported mode. */
export const terminalAttached = z.strictObject({
  terminalId: id,
  type: z.literal("attached"),
  mode: z.enum(["control", "observe"]),
})

// An agent NovaDeck can connect: whether it is installed here, and whether NovaDeck's
// plugin, which reports its sessions so they can resume, is installed into it.
export const agentIntegration = z.strictObject({
  agent: agentName,
  available: z.boolean(),
  connected: z.boolean(),
})

// Runner-wide settings a client can change.
export const runnerSettings = z.strictObject({
  // Whether each terminal's screen is kept on disk, to show again when it restores.
  transcripts: z.boolean(),
  // Whether the person has seen the first-run choice of agents to connect.
  welcomed: z.boolean(),
})

export type Project = z.infer<typeof project>
export type WorkspaceSession = z.infer<typeof workspaceSession>
export type TerminalExit = z.infer<typeof terminalExit>
export type ForegroundProcess = z.infer<typeof foregroundProcess>
export type TerminalSummary = z.infer<typeof terminalSummary>
export type TerminalChange = z.infer<typeof terminalChange>
export type TerminalEvent = z.infer<typeof terminalEvent>
export type TerminalAttached = z.infer<typeof terminalAttached>
export type AgentName = z.infer<typeof agentName>
export type AgentActivity = z.infer<typeof agentActivity>
export type AgentIntegration = z.infer<typeof agentIntegration>
export type RunnerSettings = z.infer<typeof runnerSettings>
