import { columns, exit, rows, terminalEvents } from "@novadeck/terminal"
import { z } from "zod"

import { agentActivity, agentName, agentTelemetry } from "./agents.js"
import { directory, id } from "./fields.js"

/** The largest file a client may paste into a terminal, in bytes. */
export const maxUploadBytes = 32 * 1024 * 1024
/**
 * The longest part of an upload, in base64 characters: 144 KiB of the file, so a whole
 * `terminals.upload` call fits in `maxWebSocketMessageBytes`.
 */
export const maxUploadPartLength = 196_608

// `name` is the process's own name. `argv` is the foreground process group leader's
// command line, which tells a script apart from its interpreter; null where the
// platform cannot tell and before the runner first looks. The runner truncates both
// to fit.
export const foregroundProcess = z.strictObject({
  name: z.string().max(256),
  argv: z.array(z.string().max(4096)).max(64).nullable(),
})

// A command line a new shell runs at its first prompt, as if typed there: one line of at most
// `maxStartupCommand` characters, without control characters.
export const maxStartupCommand = 4096
export const startupCommand = z
  .string()
  .min(1)
  .max(maxStartupCommand)
  // eslint-disable-next-line no-control-regex -- These are the characters it refuses.
  .regex(/^[^\x00-\x1f\x7f]*$/, "A command must be one line, without control characters.")

// The title the person gives a terminal: one line, without control characters. The
// runner owns it, keeps it with the terminal, and every client shows it.
export const terminalTitle = z
  .string()
  .trim()
  .min(1)
  // In characters, never half of one: an emoji counts once.
  .refine((title) => [...title].length <= 200, "A title holds at most 200 characters.")
  .regex(
    // eslint-disable-next-line no-control-regex -- These are the characters it refuses.
    /^[^\x00-\x1f\x7f]*$/,
    "A title must be one line, without control characters.",
  )

// A terminal's handle: a word its Novadeck session gives it as it is created, such as
// `moth`, never twice; once a session has given every word, they come again with a
// letter, as `mothz` (an older session's with a number, as `moth2`). It stays as the
// terminal is renamed, agents address each other by it, and people read it as `@moth`.
export const handle = z.string().regex(/^[a-z]{2,12}(?:[2-9]|[1-9][0-9]{1,8})?$/)

// Who a terminal's title is from: the person; murmur, the local model that describes
// terminals; an agent, by its terminal's handle (the one that opened it with a title); or
// its session's `default`.
export const titleSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person") }),
  z.strictObject({ kind: z.literal("agent"), by: handle }),
  z.strictObject({ kind: z.literal("murmur") }),
  z.strictObject({ kind: z.literal("default") }),
])

// The runner owns every terminal's identity and facts: which terminals a session has, their
// titles, directories, what they run and ran. Clients keep only how they show them.
export const terminalSummary = z.strictObject({
  id,
  sessionId: id,
  // The title the person gave the terminal; else murmur's latest, if it is on; else the
  // one the agent that opened it gave; else the runner's default: the program the terminal
  // was opened to run, as "claude", or "Terminal".
  title: terminalTitle,
  // Who the title is from.
  titleSource,
  // Its handle, which never changes.
  handle,
  // Whether the runner started a shell for it in this lifetime. A terminal it keeps only
  // as saved, as after the runner restarted, has none until a client restores it, with
  // `create` and `restore`.
  started: z.boolean(),
  // The handle of the terminal whose agent opened this one with a brief, its lead; null
  // when none. It changes only when the lead is set or ended, as when the agent here
  // exits, not while the lead's terminal runs or stops.
  ledBy: handle.nullable(),
  // The handle of the terminal whose agent opened this one, for an agent, a command or a
  // plain shell; null when the person opened it. It never changes.
  openedBy: handle.nullable(),
  // Whether an agent has reported a session in it since it opened, running now or since
  // exited. It stays true, so what names the terminal by its handle keeps a terminal to
  // find, until the person disconnects that agent's harness.
  agentRan: z.boolean(),
  // The command it was opened to run at its first prompt; null for a plain shell.
  command: startupCommand.nullable(),
  // The program in its foreground when its shell was last seen, which a fresh shell
  // resumes where it is an agent the runner knows the session of; null when unknown.
  lastProgram: z.string().max(256).nullable(),
  // The shell's current directory as its shell integration last reported it, or where
  // it started; a restart starts there.
  cwd: directory,
  cols: columns,
  rows,
  // Counts the shells this terminal has run: 1 at creation, +1 per restart, 0 while it
  // has none in this runner's lifetime. A report about an older run is stale.
  run: z.number().int().nonnegative(),
  // How the shell ended; null while it runs.
  exit: exit.nullable(),
  // The terminal's foreground process, such as the shell or a program it runs. Null
  // once exited or when the platform cannot tell.
  process: foregroundProcess.nullable(),
  // The agent that reported a session in this shell since its last prompt, so a client
  // can name the program where the process alone cannot, as on Windows. Null otherwise.
  agent: agentName.nullable(),
  // The agent whose own empty prompt shows there, with Novadeck's hooks running for it,
  // before it reported a session, as Codex and Antigravity do only with their first
  // prompt. Null otherwise, and once a session is reported.
  ready: agentName.nullable(),
  // What that agent is doing; null without one.
  activity: agentActivity.nullable(),
  // Its tokens and quotas, once its records named any; null otherwise.
  telemetry: agentTelemetry.nullable(),
  // The agent's latest `done` that still stands, read or not: nothing the person prompted
  // or a message delivered to it came after. The terminal's done mark follows it, not
  // the person looking; null without one.
  reported: z.strictObject({ subject: z.string().max(256), at: z.number() }).nullable(),
})

// `terminals.requests` items: an agent in terminal `from` asked, through Novadeck's MCP
// server, for a new terminal beside it, in `cwd`, starting `command` at its first prompt;
// `focus` when the person asked to see it. A title the agent asked for is the runner's to
// give, as the agent's: the client creates the terminal with `requestId`.
export const terminalRequest = z.strictObject({
  requestId: id,
  from: id,
  sessionId: id,
  cwd: directory,
  command: startupCommand.optional(),
  focus: z.boolean(),
})

// The client's answer to a request: the terminal it opened, or why it didn't, in a
// sentence the agent can pass on.
export const terminalRequestAnswer = z.union([
  z.strictObject({ requestId: id, terminalId: id }),
  z.strictObject({ requestId: id, reason: z.string().trim().min(1).max(512) }),
])

// What an agent asks the person to approve, through Novadeck's MCP server: `close`, a
// terminal of its session that runs an agent it doesn't lead, or `lead`, to lead the agent
// there from now on, with `brief` as the first message it sends it.
const approvalAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("close") }),
  z.strictObject({ type: z.literal("lead"), brief: z.string().min(1).max(4096) }),
])

// `terminals.approvals` items: an agent in terminal `from` asked, through Novadeck's MCP
// server, to do `action` to `terminalId`, a terminal of its session that runs an agent, so
// the client asks the person first and answers with `answerApproval`. `withdrawn` takes
// back a request the runner no longer waits for, as either terminal closed.
export const approval = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("request"),
    requestId: id,
    from: id,
    terminalId: id,
    sessionId: id,
    action: approvalAction,
  }),
  z.strictObject({ type: z.literal("withdrawn"), requestId: id }),
])

// The person's answer to an approval: `approved` when they let it happen, false when they
// kept things as they are.
export const approvalAnswer = z.strictObject({ requestId: id, approved: z.boolean() })

// `terminals.watch` events: every terminal's summary, then each later change.
export const terminalChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("changed"), terminal: terminalSummary }),
  z.strictObject({ type: z.literal("removed"), terminalId: id, sessionId: id }),
  // Follows the initial `changed` events: terminals not reported by now do not exist.
  z.strictObject({ type: z.literal("synced") }),
])

// The terminal library's attach events, each in the envelope that names its terminal, its
// field first as it always was.
export const terminalEvent = z.discriminatedUnion("type", [
  z.strictObject({ terminalId: id, ...terminalEvents.snapshot.shape }),
  z.strictObject({ terminalId: id, ...terminalEvents.output.shape }),
  z.strictObject({ terminalId: id, ...terminalEvents.resized.shape }),
  z.strictObject({ terminalId: id, ...terminalEvents.exited.shape }),
])

/** Wire-only marker: the attachment is established and holds the reported mode. */
export const terminalAttached = z.strictObject({
  terminalId: id,
  type: z.literal("attached"),
  mode: z.enum(["control", "observe"]),
})

export type TerminalExit = z.infer<typeof exit>
export type ForegroundProcess = z.infer<typeof foregroundProcess>
export type TerminalSummary = z.infer<typeof terminalSummary>
export type TitleSource = z.infer<typeof titleSource>
export type TerminalChange = z.infer<typeof terminalChange>
export type TerminalRequest = z.infer<typeof terminalRequest>
export type TerminalRequestAnswer = z.infer<typeof terminalRequestAnswer>
export type ApprovalAction = z.infer<typeof approvalAction>
export type Approval = z.infer<typeof approval>
export type ApprovalAnswer = z.infer<typeof approvalAnswer>
export type TerminalEvent = z.infer<typeof terminalEvent>
export type TerminalAttached = z.infer<typeof terminalAttached>
