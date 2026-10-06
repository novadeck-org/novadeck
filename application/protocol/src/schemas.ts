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

/** The largest file a client may paste into a terminal, in bytes. */
export const maxUploadBytes = 32 * 1024 * 1024
/**
 * The longest part of an upload, in base64 characters: 144 KiB of the file, so a whole
 * `terminals.upload` call fits in `maxWebSocketMessageBytes`.
 */
export const maxUploadPartLength = 196_608

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

// Agents whose sessions Novadeck identifies and can resume once connected: Claude Code,
// Codex and Antigravity. An agent session id is what the agent itself names its
// session: a UUID today, kept to a plain token so a shell can run it as it is.
export const agentName = z.enum(["claude", "codex", "agy"])
export const agentSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

// How long the start of an agent's last reply runs at most, in UTF-16 code units: enough
// for a notification's line, and never the whole reply.
export const replyPreviewLength = 120

// What the agent holding a terminal's foreground is doing, as its own hooks report it:
// working on a turn, or with its turn over while subagents it started run on, which will
// wake the agent (`background`); idle otherwise; or unknown when they have not said. `attention`
// counts the requests waiting on the person, and names the kind of the oldest one.
export const agentActivity = z.strictObject({
  state: z.enum(["working", "idle", "unknown"]),
  // What its ended turn left running that wakes it once done: subagents, which keep it
  // working, and other tasks such as commands, which don't, as one may run for ever,
  // counted; both zero where its harness says only that something runs. Null while its
  // turn runs, and once nothing it started runs.
  background: z
    .strictObject({
      agents: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
    })
    .nullable(),
  attention: z.strictObject({
    pending: z.number().int().nonnegative(),
    kind: z.enum(["permission", "question", "plan"]).nullable(),
  }),
  // Whether it plans rather than acts, as its hooks last said.
  planning: z.boolean(),
  // Its subagents running now, oldest first, each with its kind in the harness's words.
  subagents: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256),
        type: z.string().max(256).nullable(),
      }),
    )
    .max(32),
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
      reply: z.string().min(1).max(replyPreviewLength).nullable(),
      at: z.number(),
    })
    .nullable(),
})

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
    .max(8),
})

// A runner-issued reference to an agent's actor or request: clients compare it, and
// never see a harness's own ids.
export const agentRef = z.string().regex(/^[A-Za-z0-9_-]{16}$/)

// How much of a feature Novadeck can tell of an agent: all of it, some, or nothing.
const coverageLevel = z.enum(["unsupported", "partial", "complete"])
export const agentCoverage = z.strictObject({
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
        type: z.string().max(256).nullable(),
      }),
    )
    .max(33),
  requests: z
    .array(
      z.strictObject({
        ref: agentRef,
        actor: agentRef,
        kind: z.enum(["permission", "question", "plan"]),
        tool: z.string().max(256),
        subject: z.string().max(1024).nullable(),
        choices: z.array(z.string().max(256)).max(16),
      }),
    )
    .max(32),
  coverage: agentCoverage.nullable(),
})

// `agents.transcript` changes: items of an actor's conversation in the order its harness
// recorded them, numbered from the start of the record (a tool's result may come before
// its call, which `call` pairs it with); or `reset`, when the record
// was rewritten and its items follow again from the start. An item is the person's or
// the agent's text, another agent's message to it (`author` names that agent, in its
// harness's words), a tool call, with its input as text, or a tool's result; `call`
// pairs a result with its call. Text past 16 KiB is cut short and marked `truncated`.
// Private reasoning is never included.
export const transcriptItem = z.strictObject({
  index: z.number().int().nonnegative(),
  at: z.number().nullable(),
  role: z.enum(["user", "assistant", "agent", "tool"]),
  kind: z.enum(["text", "tool-call", "tool-result"]),
  text: z.string().max(16_384),
  truncated: z.boolean(),
  tool: z.string().max(256).nullable(),
  call: agentRef.nullable(),
  author: z.string().max(256).nullable(),
})
export const transcriptChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("items"), items: z.array(transcriptItem).min(1).max(256) }),
  z.strictObject({ type: z.literal("reset") }),
])

// A command line a new shell runs at its first prompt, as if typed there: one line,
// without control characters.
export const startupCommand = z
  .string()
  .min(1)
  .max(4096)
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

// A terminal's handle: `t` and a number its Novadeck session gives it as it is created,
// never twice, from the same count as its default title ("Terminal 03" is `t3`). It
// stays as the terminal is renamed, and agents address each other by it.
export const handle = z.string().regex(/^t[1-9][0-9]{0,8}$/)

// Who a terminal's title is from: the person; an agent, by its terminal's handle (the
// one that opened it with a title, or its own through `describe`); the person's first
// prompt of its agent's root session (`fallback`); or its session's `default`.
export const titleSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person") }),
  z.strictObject({ kind: z.literal("agent"), by: handle }),
  z.strictObject({ kind: z.literal("fallback") }),
  z.strictObject({ kind: z.literal("default") }),
])

// The runner owns every terminal's identity and facts: which terminals a session has, their
// titles, directories, what they run and ran. Clients keep only how they show them.
export const terminalSummary = z.strictObject({
  id,
  sessionId: id,
  // The title the person gave the terminal; else the one an agent gave it last, or the
  // person's first prompt to its agent, shortened; else the runner's default for its
  // session ("Terminal 01", "Terminal 02", … in the order they were created).
  title: terminalTitle,
  // Who the title is from.
  titleSource,
  // Its handle, which never changes.
  handle,
  // Whether the runner started a shell for it in this lifetime. A terminal it keeps only
  // as saved, as after the runner restarted, has none until a client restores it, with
  // `create` and `restore`.
  started: z.boolean(),
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
  exit: terminalExit.nullable(),
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
})

// What agents show and the person attaches beside a terminal: a pointer to a file, a
// page or a plan, never a copy of it, which `companions.content` reads when it loads.
// Each item has one holder, a terminal's bar or an undocked window; `from` is the
// terminal it was shown or attached in. `version` counts its shows, `asked` says the
// latest one asked to open it, and `held` marks a file that may hold secrets, which
// opens only when the person picks it. A plan names its agent, its actor's role, and
// whether it is a file or text in the agent's own transcript or rollout.
export const itemHolder = z.union([
  z.strictObject({ terminalId: id }),
  z.strictObject({ windowId: id }),
])
export const companionItem = z.strictObject({
  id,
  sessionId: id,
  holder: itemHolder,
  kind: z.enum(["image", "file", "page", "plan"]),
  name: z.string().max(256),
  detail: z.string().max(512),
  path: z.string().max(4096).nullable(),
  url: z.string().max(8192).nullable(),
  lines: z.strictObject({ from: z.int().min(1), to: z.int().min(1) }).nullable(),
  held: z.boolean(),
  by: z.enum(["agent", "person"]),
  from: z.strictObject({ terminalId: id, handle }),
  version: z.int().min(1),
  asked: z.boolean(),
  shownAt: z.number(),
  plan: z
    .strictObject({
      agent: agentName,
      role: z.enum(["root", "subagent"]),
      source: z.enum(["file", "text"]),
    })
    .nullable(),
})

// An undocked window holding one item, named by the client that undocked it. Its title is
// the person's, or by default the item's name.
export const companionWindow = z.strictObject({
  id,
  sessionId: id,
  itemId: id,
  title: terminalTitle,
  titleSource: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("person") }),
    z.strictObject({ kind: z.literal("default") }),
  ]),
})

// `companions.watch` events: every item and window, `synced`, then each later change.
export const companionChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("item"), item: companionItem }),
  z.strictObject({ type: z.literal("itemRemoved"), itemId: id, sessionId: id }),
  z.strictObject({ type: z.literal("window"), window: companionWindow }),
  z.strictObject({ type: z.literal("windowRemoved"), windowId: id, sessionId: id }),
  // Follows the initial events: items and windows not reported by now do not exist.
  z.strictObject({ type: z.literal("synced") }),
])

// `companions.content`: what an item points at, read as it is now. `stamp` changes with
// it. A file is the lines around the ones pointed at, numbered from `firstLine`, with
// its line count where it was read to its end (`truncated` otherwise), and `clamped`
// when the lines pointed at ran past its end. A page is its address, which the desktop
// app loads live. Or why it can't be shown, with the file's size where known.
export const itemContent = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ready"),
    stamp: z.string().max(128),
    content: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("image"), src: z.string().max(12 * 1024 * 1024) }),
      z.strictObject({
        kind: z.literal("file"),
        path: z.string().max(4096),
        firstLine: z.int().min(1),
        lines: z.array(z.string().max(4096)).max(2000),
        from: z.int().min(1),
        to: z.int().min(1),
        total: z.int().nonnegative().nullable(),
        truncated: z.boolean(),
        clamped: z.boolean(),
      }),
      z.strictObject({ kind: z.literal("page"), url: z.string().max(8192) }),
      z.strictObject({
        kind: z.literal("plan"),
        text: z.string().max(256 * 1024),
        truncated: z.boolean(),
        changedAt: z.number().nullable(),
      }),
    ]),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum(["missing", "unreadable", "not-a-file", "too-large", "binary", "held", "gone"]),
    size: z.number().nullable(),
  }),
])

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

// An agent Novadeck can connect: whether it is installed here, and whether Novadeck's
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

// Voice input: speech typed into terminals, transcribed on this machine by an engine and
// a model the person installs from Preferences. `turbo` is accurate in many languages but
// wants a GPU; `small` is quicker on a CPU and less accurate.
export const voiceModel = z.enum(["turbo", "small"])
// The language spoken: `auto` to detect it, or a code Whisper knows, such as "en" or "pl".
export const voiceLanguage = z.string().regex(/^(auto|[a-z]{2,3})$/)

/** Voice clips are 16 kHz mono 16-bit little-endian PCM. */
export const voiceSampleRate = 16_000
/** The longest clip, in seconds. */
export const maxVoiceSeconds = 120
/**
 * The longest part of a clip, in base64 characters: 144 KiB of audio, so a whole
 * `voice.record` call fits in `maxWebSocketMessageBytes`.
 */
export const maxVoicePartLength = 196_608

// What an install is doing: downloading the engine or the model, or checking that they
// transcribe, with the bytes received of the step's total.
export const voiceInstall = z.strictObject({
  model: voiceModel,
  step: z.enum(["engine", "model", "check"]),
  received: z.int().nonnegative(),
  total: z.int().nonnegative(),
})

// How the engine did on a test clip after an install: how long it took, whether it ran on
// a GPU, and the model that suits this machine.
export const voiceCheck = z.strictObject({
  model: voiceModel,
  milliseconds: z.int().nonnegative(),
  gpu: z.boolean(),
  recommended: voiceModel,
})

export const voiceState = z.strictObject({
  // Whether this build has an engine for this platform; without one nothing installs.
  available: z.boolean(),
  // The models on disk beside the engine; empty until an install finishes.
  installed: z.array(voiceModel),
  // Whether the person turned voice input on; it needs `model` installed.
  enabled: z.boolean(),
  model: voiceModel,
  language: voiceLanguage,
  // Download sizes in bytes: the engine for this platform, and each model.
  sizes: z.strictObject({ engine: z.int().nonnegative(), turbo: z.int(), small: z.int() }),
  installing: voiceInstall.nullable(),
  check: voiceCheck.nullable(),
  // Why the last install, or the engine, failed, until the next install or transcription.
  failure: z.string().max(1024).nullable(),
})

export const voiceSettings = z.strictObject({
  enabled: z.boolean(),
  model: voiceModel,
  language: voiceLanguage,
})

export const voiceTranscript = z.strictObject({
  text: z.string(),
  // The language the engine heard, as a code such as "en".
  language: z.string(),
})

export const messageId = z.string().regex(/^m-[a-z0-9]{1,32}$/)
export const threadId = z.string().regex(/^t-[a-z0-9]{1,32}$/)

// Where a message is on its way: waiting for its recipient's next hook (`queued`), handed
// to a hook that has yet to confirm it printed it (`leased`), printed to the recipient's
// harness (`delivered`), held while messaging is paused or its thread awaits the
// person's release (`held`), or no longer deliverable since its recipient's session
// ended (`gone`), until that same session runs there again.
export const messageState = z.enum(["queued", "leased", "delivered", "held", "gone"])

// How a terminal's agent can take a message now: no agent there (`unbound`), a session
// bound that has had no turn yet (`fresh`), the agent's own empty input prompt showing
// with no turn yet, its session bound or about to bind (`ready`), a turn running
// (`working`), a turn that ended normally with the prompt known empty (`settled`), the
// doorbell waking it (`ringing`), the person busy at the prompt (`drafting`), or a turn
// that ended without a normal stop (`unknown`).
export const deliveryState = z.enum([
  "unbound",
  "fresh",
  "ready",
  "working",
  "settled",
  "ringing",
  "drafting",
  "unknown",
])

// One message between two terminals' agents, as sent: its text up to 4 KB, its place in
// its thread, and where it is on its way. `held` says why a held message waits: messaging
// is paused, or its thread awaits the person's `messages.release`.
export const agentMessage = z.strictObject({
  id: messageId,
  thread: threadId,
  hop: z.number().int().positive(),
  from: handle,
  fromAgent: agentName.nullable(),
  to: handle,
  toAgent: agentName,
  text: z.string().max(4096),
  sentAt: z.number(),
  state: messageState,
  held: z.enum(["paused", "release"]).nullable(),
  deliveredAt: z.number().nullable(),
})

// A thread between a terminal and one other: the other's handle, how many messages it
// has had and may have before the person releases it again, and its messages, oldest
// first. `held` while some wait for that release.
export const messageThread = z.strictObject({
  id: threadId,
  peer: handle,
  hops: z.number().int().nonnegative(),
  allowed: z.number().int().nonnegative(),
  held: z.boolean(),
  messages: z.array(agentMessage).max(1000),
})

// `messages.list`: a terminal's handle, how its agent can take messages now, whether
// messaging is paused, and every thread it is in, latest first.
export const terminalMessages = z.strictObject({
  terminalId: id,
  handle,
  delivery: deliveryState,
  paused: z.boolean(),
  threads: z.array(messageThread).max(1000),
})

export type Project = z.infer<typeof project>
export type WorkspaceSession = z.infer<typeof workspaceSession>
export type TerminalExit = z.infer<typeof terminalExit>
export type ForegroundProcess = z.infer<typeof foregroundProcess>
export type TerminalSummary = z.infer<typeof terminalSummary>
export type TitleSource = z.infer<typeof titleSource>
export type TerminalChange = z.infer<typeof terminalChange>
export type ItemHolder = z.infer<typeof itemHolder>
export type CompanionItem = z.infer<typeof companionItem>
export type CompanionWindow = z.infer<typeof companionWindow>
export type CompanionChange = z.infer<typeof companionChange>
export type ItemContent = z.infer<typeof itemContent>
export type TerminalRequest = z.infer<typeof terminalRequest>
export type TerminalRequestAnswer = z.infer<typeof terminalRequestAnswer>
export type TerminalEvent = z.infer<typeof terminalEvent>
export type TerminalAttached = z.infer<typeof terminalAttached>
export type AgentName = z.infer<typeof agentName>
export type AgentActivity = z.infer<typeof agentActivity>
export type AgentTelemetry = z.infer<typeof agentTelemetry>
export type AgentCoverage = z.infer<typeof agentCoverage>
export type AgentDetail = z.infer<typeof agentDetail>
export type TranscriptItem = z.infer<typeof transcriptItem>
export type TranscriptChange = z.infer<typeof transcriptChange>
export type AgentIntegration = z.infer<typeof agentIntegration>
export type RunnerSettings = z.infer<typeof runnerSettings>
export type VoiceModel = z.infer<typeof voiceModel>
export type VoiceInstall = z.infer<typeof voiceInstall>
export type VoiceCheck = z.infer<typeof voiceCheck>
export type VoiceState = z.infer<typeof voiceState>
export type VoiceSettings = z.infer<typeof voiceSettings>
export type VoiceTranscript = z.infer<typeof voiceTranscript>
export type MessageState = z.infer<typeof messageState>
export type DeliveryState = z.infer<typeof deliveryState>
export type AgentMessage = z.infer<typeof agentMessage>
export type MessageThread = z.infer<typeof messageThread>
export type TerminalMessages = z.infer<typeof terminalMessages>
