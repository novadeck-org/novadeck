import { z } from "zod"

import { requestDialog } from "./dialogs.js"
import { id } from "./fields.js"
import { harnessIds } from "./harnesses.js"

// Agents whose sessions Novadeck identifies and can resume once connected: Claude Code,
// Codex and Antigravity. An agent session id is what the agent itself names its
// session: a UUID today, kept to a plain token so a shell can run it as it is.
export const agentName = z.enum(harnessIds)
export const agentSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

// How long the start of an agent's last reply runs at most, in UTF-16 code units: enough
// for one line of a desktop notice or an Inbox row, and never the whole reply.
export const replyPreviewLength = 120

// How long a failed turn's error runs at most, and how many files a turn names, each a path
// of at most `maxTurnFilePath`, in UTF-16 code units. Producers cut to these.
export const maxTurnError = 2048
export const maxTurnFiles = 16
export const maxTurnFilePath = 1024

// How much an agent's activity and detail carry at most: its subagents running, the jobs it
// waits on, its actors (the root and its subagents) and the requests waiting on the person,
// a request's choices; and, in UTF-16 code units, a name (an id, a kind, a tool, a choice),
// a description (a job's, a wake's reason), a request's subject and a waited job's command.
export const agentLimits = {
  subagents: 32,
  jobs: 16,
  actors: 33,
  requests: 32,
  choices: 16,
  name: 256,
  description: 512,
  subject: 1024,
  command: 4096,
} as const

// Fields of an agent's last turn, shared by its summary and by a stored turn entry.
export const turnReply = z.string().min(1).max(replyPreviewLength)
export const turnError = z.string().min(1).max(maxTurnError)
export const turnFiles = z.array(z.string().min(1).max(maxTurnFilePath)).max(maxTurnFiles)

// What the agent holding a terminal's foreground is doing, as its own hooks report it:
// working on a turn, or with its turn over while subagents it started run on, which will
// wake the agent (`background`); idle otherwise; or unknown when they have not said. `attention`
// counts the requests waiting on the person, and names the kind of the oldest one.
export const agentActivity = z.strictObject({
  state: z.enum(["working", "idle", "unknown"]),
  // What its ended turn left running that wakes it once done: subagents, which keep it
  // working, and other tasks such as commands, which don't, as one may run for ever,
  // counted; both zero where its harness says only that something runs. While its turn
  // runs, only the subagents its harness counts running then, as Antigravity's do; null
  // otherwise, and once nothing it started runs.
  background: z
    .strictObject({
      agents: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
    })
    .nullable(),
  // What its ended turn waits on, which wakes it with no word from anyone: jobs it left
  // running and picks up once they finish (a command run in the background, a Monitor),
  // and a wake-up it set itself. Work that may run for ever, as a dev server, isn't
  // waited on. Each job is described in the agent's own words where it gave them, with
  // when it started and, where its harness gives up on it (a Monitor's timeout), when
  // that is, in epoch milliseconds. Null while a turn runs, where its harness doesn't
  // tell, and once it waits on nothing.
  waiting: z
    .strictObject({
      jobs: z
        .array(
          z.strictObject({
            id: z.string().min(1).max(agentLimits.name),
            description: z.string().min(1).max(agentLimits.description).nullable(),
            command: z.string().max(agentLimits.command),
            since: z.number(),
            until: z.number().nullable(),
          }),
        )
        .max(agentLimits.jobs),
      wake: z
        .strictObject({
          at: z.number(),
          reason: z.string().min(1).max(agentLimits.description).nullable(),
        })
        .nullable(),
    })
    .nullable(),
  attention: z.strictObject({
    pending: z.number().int().nonnegative(),
    kind: z.enum(["permission", "question", "plan"]).nullable(),
    // How many of them ask without waiting, as Codex's async questions: the agent works on,
    // and takes prompts and messages; absent where none does.
    detached: z.number().int().positive().optional(),
  }),
  // Whether it plans rather than acts, as its hooks last said.
  planning: z.boolean(),
  // Its subagents running now, oldest first, each with its kind in the harness's words.
  subagents: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(agentLimits.name),
        type: z.string().max(agentLimits.name).nullable(),
      }),
    )
    .max(agentLimits.subagents),
  // How its latest turn ended: `completed` as its harness said, `failed` on an error,
  // `interrupted` by the person (Escape, or a request they refused, as its hooks or records
  // tell), or `unknown` when it only went idle, as an Escape or a refusal shows in
  // Antigravity. `reply` is the start of what the agent said last in that turn, one line of
  // plain text, where its harness tells it. `at` tells one end from another: when it was
  // reported, in epoch milliseconds, kept as a later report only fills in the same end's
  // reply. Null while a turn runs and before the first ends.
  lastTurn: z
    .strictObject({
      outcome: z.enum(["completed", "failed", "interrupted", "unknown"]),
      reply: turnReply.nullable(),
      at: z.number(),
      // A failed turn's error as its harness said it; null otherwise or where it gave none.
      error: turnError.nullable(),
      // The usage-limit window this end ran into: its harness said the turn failed on a
      // limit; its records, within a minute of the end, only tell when it resets.
      // Kept for this end once set. Null where none, or no reset time is known.
      limit: z
        .strictObject({
          minutes: z.number().int().positive().nullable(),
          resetsAt: z.number(),
        })
        .nullable(),
      // Absolute paths its write/edit tools wrote in the turn (root and subagents), first
      // written first, each once.
      files: turnFiles,
      // True only where this end ran into a usage limit, whether or not its window is known
      // (`limit`), so a client shows a limited end without a window as the state it is.
      limited: z.literal(true).optional(),
    })
    .nullable(),
})

// How many rate-limit windows an agent's telemetry carries, and how long its model's and
// effort's names run, in UTF-16 code units.
export const telemetryLimits = { windows: 8, model: 128, effort: 32 } as const

// What an agent's own records say of its tokens and quotas: how many tokens its context
// holds, of how many where known, and how much of each rate-limit window it has used, as
// a fraction, with the instant the window resets in epoch milliseconds where known. Every
// harness reports limits this way; none reports the limit itself.
export const agentTelemetry = z.strictObject({
  context: z
    .strictObject({
      occupied: z.number().int().nonnegative(),
      capacity: z.number().int().positive().nullable(),
    })
    .nullable(),
  limits: z
    .array(
      z.strictObject({
        minutes: z.number().int().positive().nullable(),
        used: z.number().min(0).max(1),
        resetsAt: z.number().nullable(),
      }),
    )
    .max(telemetryLimits.windows),
  // The model it runs, in its harness's words (a display name where it gives one), and
  // the reasoning effort it was set to; null where its harness doesn't say.
  model: z.string().min(1).max(telemetryLimits.model).nullable(),
  effort: z.string().min(1).max(telemetryLimits.effort).nullable(),
})

// A runner-issued reference to an agent's actor or request: clients compare it, and
// never see a harness's own ids.
export const agentRef = z.string().regex(/^[A-Za-z0-9_-]{16}$/)

// How much of a feature Novadeck can tell of an agent: all of it, some, or nothing.
const coverageLevel = z.enum(["unsupported", "partial", "complete"])
const agentCoverage = z.strictObject({
  session: coverageLevel,
  activity: coverageLevel,
  attention: coverageLevel,
  actors: coverageLevel,
  transcripts: coverageLevel,
  planning: coverageLevel,
  usage: coverageLevel,
  limits: coverageLevel,
  context: coverageLevel,
})

// `agents.detail` snapshots: the agent a terminal runs, its root and subagents (root
// first; a subagent's parent is null where the harness does not say), each request
// waiting on the person with what it asks about and the answers it offers, and how much
// of each feature this harness tells. Without an agent bound, only `terminalId`. Its
// plans are companion items (`companionItem`).
export const agentDetail = z.strictObject({
  terminalId: id,
  agent: agentName.nullable(),
  sessionId: agentSessionId.nullable(),
  activity: agentActivity.nullable(),
  telemetry: agentTelemetry.nullable(),
  actors: z
    .array(
      z.strictObject({
        ref: agentRef,
        role: z.enum(["root", "subagent"]),
        parent: agentRef.nullable(),
        type: z.string().max(agentLimits.name).nullable(),
      }),
    )
    .max(agentLimits.actors),
  requests: z
    .array(
      z.strictObject({
        ref: agentRef,
        actor: agentRef,
        kind: z.enum(["permission", "question", "plan"]),
        tool: z.string().max(agentLimits.name),
        subject: z.string().max(agentLimits.subject).nullable(),
        choices: z.array(z.string().max(agentLimits.name)).max(agentLimits.choices),
        dialog: requestDialog.nullable(),
        // Whether Novadeck answered it, through `agents.answer`, and the agent has yet to
        // report it settled: nothing more is to be answered there meanwhile.
        answered: z.boolean(),
        // When the request's hook started, on the runner's clock, in epoch milliseconds.
        askedAt: z.number(),
      }),
    )
    .max(agentLimits.requests),
  coverage: agentCoverage.nullable(),
})

// An agent Novadeck can connect: whether it is installed here, and whether Novadeck's
// plugin, which reports its sessions so they can resume, is installed into it.
export const agentIntegration = z.strictObject({
  agent: agentName,
  available: z.boolean(),
  connected: z.boolean(),
  // What keeps a connected agent's messaging from working whole, where something does:
  // `own-status-line`, Antigravity on Windows running the person's own status line, which
  // keeps Novadeck's out, so it is never seen Ready at its first prompt.
  limited: z.enum(["own-status-line"]).optional(),
})

/**
 * Why a `CONFLICT` about typing into an agent's terminal is one, as its data, so a client
 * can tell what clears by itself from what the person settles in the terminal:
 * - `pending`: a request waits on the person, whose dialog would take the text;
 * - `ringing`: another agent's message is reaching the agent (its doorbell rings);
 * - `draft`: the agent's input box holds text already;
 * - `no-agent`: no agent is running in the terminal;
 * - `no-box`: no input box is found on the agent's screen;
 * - `too-tall`: the text has no room in the box on this screen;
 * - `shell`: the box is in its shell mode;
 * - `no-paste`: the screen takes no bracketed paste yet.
 * Other conflicts carry no data; a client must take a reason it doesn't know as none.
 */
export const conflictReason = z.strictObject({
  reason: z.enum([
    "pending",
    "ringing",
    "draft",
    "no-agent",
    "no-box",
    "too-tall",
    "shell",
    "no-paste",
  ]),
})

/**
 * What `agents.interrupt` gives back: the words the person had queued behind the turn that
 * the agent's input box took back as the turn was stopped (Claude Code and Antigravity
 * hand queued messages back for editing), now cleared out of the box, which the chat puts
 * back in the person's draft; null when there were none, and always for Codex, whose
 * queued message goes to the agent as a steer.
 */
export const interruptResult = z.strictObject({ returned: z.string().nullable() })
export type InterruptResult = z.infer<typeof interruptResult>

export type { AgentName } from "./harnesses.js"
export type AgentActivity = z.infer<typeof agentActivity>
export type AgentTelemetry = z.infer<typeof agentTelemetry>
export type AgentCoverage = z.infer<typeof agentCoverage>
export type AgentDetail = z.infer<typeof agentDetail>
export type AgentIntegration = z.infer<typeof agentIntegration>
