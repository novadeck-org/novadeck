import { columns, exit, rows, terminalEvents } from "@novadeck/terminal"
import { z } from "zod"

import { harnessIds } from "./harnesses.js"

export const protocolVersion = 1
export const id = z.uuid()
export const name = z.string().trim().min(1).max(200)
export const directory = z.string().min(1).max(4096)

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
export const agentName = z.enum(harnessIds)
export const agentSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

// How long the start of an agent's last reply runs at most, in UTF-16 code units: enough
// for a notification's line, and never the whole reply.
export const replyPreviewLength = 120

// Murmur's words for the person, never for agents: one line, no control characters.
// eslint-disable-next-line no-control-regex -- These are the characters it refuses.
const oneLine = /^[^\x00-\x1f\x7f-\x9f]*$/
const murmurLine = (max: number) => z.string().min(1).max(max).regex(oneLine)
export const murmurGistLength = 96
export const murmurGist = murmurLine(murmurGistLength)

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
      // Murmur's gist of the last reply, written once a client showed this end unread
      // (`murmur.gist`). It never changes `outcome`.
      gist: murmurGist.nullable(),
      // A failed turn's error as its harness said it; null otherwise or where it gave none.
      error: z.string().min(1).max(2048).nullable(),
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
      files: z.array(z.string().min(1).max(1024)).max(16),
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
  // The model it runs, in its harness's words (a display name where it gives one), and
  // the reasoning effort it was set to; null where its harness doesn't say.
  model: z.string().min(1).max(128).nullable(),
  effort: z.string().min(1).max(32).nullable(),
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

// What a request's dialog in the agent's TUI offers, as the harness's adapter read it from
// the terminal's screen, so the person can answer it from the chat (`agents.answer`):
// - `choices`: options to pick one of, as a permission or a plan approval offers. `text`
//   says an option takes the person's words: typed into the dialog's own field (`field`),
//   or sent as the agent's next prompt once the option is chosen (`prompt`).
// - `questions`: one or more questions, each with its options, whether several may be
//   picked, and whether the person may answer in their own words; and whether the person
//   may set them aside to talk it over first (`chat`): their words then reach the agent
//   typed into the dialog (`field`) or as its next prompt once the questions are set
//   aside (`prompt`); null where the harness offers no such way.
// - `form`: a form an MCP server asks the person to fill (an elicitation): its message,
//   and its fields, each text, a number, yes or no, or one of a set of choices, with
//   whether it must be filled. The person accepts it with their values, or declines it.
// - `raw`: a dialog is up for the request, but the adapter can't answer it safely: it
//   doesn't recognise it (`unrecognized`, as after an update changed the TUI), the harness
//   offers no way to answer it from outside (`unsupported`), or an answer was pressed and
//   the dialog didn't go as expected (`failed`). `text` is the screen's text around it,
//   for the person to read; they answer in the terminal.
// A readable dialog has an `id`, a fingerprint of what the runner read: an answer names
// it, and is refused, pressing nothing, when the dialog on screen no longer reads the same
// (an option renumbered as the terminal narrowed, another request's dialog in its place).
// `detail` is what the dialog shows of what it asks about (the tool's arguments, the
// permission asked for), as the terminal draws it, for the person to read. A command is the
// exception: it is the request's own command, exactly as it will run.
// Null while the dialog isn't on screen yet, or the request asks nothing on screen.
const dialogOption = z.strictObject({
  id: z.string().max(64),
  label: z.string().max(512),
  text: z.enum(["field", "prompt"]).nullable(),
})
export const requestDialog = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choices"),
    id: z.string().max(64),
    title: z.string().max(1024).nullable(),
    detail: z.string().max(4096).nullable(),
    options: z.array(dialogOption).min(1).max(16),
  }),
  z.strictObject({
    type: z.literal("questions"),
    id: z.string().max(64),
    chat: z.enum(["field", "prompt"]).nullable(),
    questions: z
      .array(
        z.strictObject({
          id: z.string().max(64),
          header: z.string().max(256).nullable(),
          question: z.string().max(2048),
          options: z
            .array(
              z.strictObject({
                id: z.string().max(64),
                label: z.string().max(512),
                description: z.string().max(2048).nullable(),
              }),
            )
            .max(16),
          multiSelect: z.boolean(),
          text: z.boolean(),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({
    type: z.literal("form"),
    id: z.string().max(64),
    message: z.string().max(2048),
    fields: z
      .array(
        z.strictObject({
          id: z.string().max(128),
          label: z.string().max(512),
          description: z.string().max(2048).nullable(),
          kind: z.enum(["text", "number", "boolean", "choice"]),
          choices: z.array(z.string().max(512)).max(32),
          required: z.boolean(),
        }),
      )
      .max(16),
  }),
  z.strictObject({
    type: z.literal("raw"),
    text: z.string().max(4096),
    reason: z.enum(["unrecognized", "unsupported", "failed"]),
  }),
])

// The person's answer to a request's dialog, naming the dialog they answered by its `id`:
// one of its `choices` by id, with their words for an option that takes them; an answer
// per question, by ids, with the options picked and/or their own words; a `questions`
// dialog set aside to talk it over (`chat`), with the person's words (needed where its
// `chat` is `field`); or a form accepted with a value per field, by id, or declined.
export const requestAnswer = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("choice"),
    dialog: z.string().max(64),
    option: z.string().max(64),
    text: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    type: z.literal("questions"),
    dialog: z.string().max(64),
    answers: z
      .array(
        z.strictObject({
          question: z.string().max(64),
          options: z.array(z.string().max(64)).max(16),
          text: z.string().min(1).max(16_384).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  z.strictObject({
    type: z.literal("chat"),
    dialog: z.string().max(64),
    text: z.string().min(1).max(16_384).optional(),
  }),
  z.strictObject({
    type: z.literal("form"),
    dialog: z.string().max(64),
    action: z.enum(["accept", "decline"]),
    values: z
      .record(z.string().max(128), z.union([z.string().max(4096), z.number(), z.boolean()]))
      .refine((values) => Object.keys(values).length <= 16, "At most 16 fields"),
  }),
])

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
        dialog: requestDialog.nullable(),
        // Whether Novadeck answered it, through `agents.answer`, and the agent has yet to
        // report it settled: nothing more is to be answered there meanwhile.
        answered: z.boolean(),
        // When the request's hook started, on the runner's clock, in epoch milliseconds.
        askedAt: z.number(),
      }),
    )
    .max(32),
  coverage: agentCoverage.nullable(),
})

// What a tool call was, as its harness's decoder says: the chat's one line for it. Both
// strings are bounded as the item's own text is, since they are derived from it.
export const toolRun = z.strictObject({
  kind: z.enum(["run", "read", "write", "search", "web", "agent", "plan", "other"]),
  // What the tool is called to a person: "Ran", "Edited", "Messaged @fox", or an unknown
  // tool's own name.
  title: z.string().max(16_384),
  // What it was called on: the command, the file, the pattern. Empty where there is none.
  detail: z.string().max(16_384),
})
// `agents.transcript` changes: items of an actor's conversation in the order its harness
// recorded them, numbered from the start of the record (a tool's result may come before
// its call, which `call` pairs it with); or `reset`, when the record
// was rewritten and its items follow again from the start. An item is the person's or
// the agent's text, another agent's message to it (`author` names that agent, in its
// harness's words), a tool call, with its input as text, or a tool's result; `call`
// pairs a result with its call, and `run` says what a call was. Text past 16 KiB is cut
// short and marked `truncated`. Private reasoning is never included.
// The refinement on an item makes `.pick`, `.omit` and `.partial` of it throw; `.extend` works.
export const transcriptItem = z
  .strictObject({
    index: z.number().int().nonnegative(),
    at: z.number().nullable(),
    role: z.enum(["user", "assistant", "agent", "tool"]),
    kind: z.enum(["text", "tool-call", "tool-result"]),
    text: z.string().max(16_384),
    truncated: z.boolean(),
    tool: z.string().max(256).nullable(),
    call: agentRef.nullable(),
    author: z.string().max(256).nullable(),
    // On a tool call, what it was; null on every other item.
    run: toolRun.nullable(),
    // A user item that records a stopped turn.
    interrupted: z.boolean(),
  })
  .refine((item) => (item.run !== null) === (item.kind === "tool-call"), {
    message: "A tool call has a run, and no other item does",
    path: ["run"],
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

// A terminal's handle: a word its Novadeck session gives it as it is created, such as
// `moth`, never twice; once a session has given every word, they come again with a
// number, as `moth2`. It stays as the terminal is renamed, agents address each other by
// it, and people read it as `@moth`.
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

// `companions.save`: the plan's new stamp, or, when it changed since the stamp the edit was
// made on, the plan as it now stands.
export const planSaveResult = z.discriminatedUnion("saved", [
  z.strictObject({ saved: z.literal(true), stamp: z.string().max(128) }),
  z.strictObject({
    saved: z.literal(false),
    current: z.strictObject({
      stamp: z.string().max(128),
      text: z.string().max(256 * 1024),
      truncated: z.boolean(),
      // As in the plan's content.
      skill: z.boolean(),
    }),
  }),
])

// `companions.pageTrouble` items: what went wrong on a page an agent showed, as the desktop
// pane saw it while the page was at the address's origin it was shown at. An `error` the
// page logged or threw, with the script and line it came from (0 when unknown); a
// `request` of the page's own origin, the page itself or what it loaded (`what`: "page",
// "script", "fetch", "img"…), answered with an HTTP error `status`, or 0 for none at all;
// or a `load` of the page that failed outright, with Chromium's error, as a server that
// isn't running.
export const pageTrouble = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("error"),
    text: z.string().max(1024),
    source: z.string().max(2048),
    line: z.int().min(0),
  }),
  z.strictObject({
    kind: z.literal("request"),
    url: z.string().max(2048),
    status: z.int().min(0).max(999),
    what: z.string().max(32),
  }),
  z.strictObject({ kind: z.literal("load"), text: z.string().max(256) }),
])

/** How many troubles one `companions.pageTrouble` call carries at most. */
export const maxPageTroubles = 20

// `companions.content`: what an item points at, read as it is now. `stamp` changes with
// it. A file is the lines around the ones pointed at, numbered from `firstLine`, with
// its line count where it was read to its end (`truncated` otherwise), and `clamped`
// when the lines pointed at ran past its end. A page is its address, which the desktop
// app loads live; `shown`, the item's version it was read at, counts the agent's shows,
// each of which loads it afresh, and `scroll` is the element that show brings into view.
// Or why it can't be shown, with the file's size where known.
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
      z.strictObject({
        kind: z.literal("page"),
        url: z.string().max(8192),
        shown: z.int().min(1),
        scroll: z.string().max(1024).optional(),
      }),
      z.strictObject({
        kind: z.literal("plan"),
        text: z.string().max(256 * 1024),
        truncated: z.boolean(),
        changedAt: z.number().nullable(),
        // Whether `companions.save` can write it: a plan in a file, not one the agent
        // keeps in its transcript.
        writable: z.boolean(),
        // Whether Novadeck's plugin is installed into the plan's agent, which tells it to
        // re-read the plan and apply the notes left in it.
        skill: z.boolean(),
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

// Runner-wide settings a client can change.
export const runnerSettings = z.strictObject({
  // Whether each terminal's screen is kept on disk, to show again when it restores.
  transcripts: z.boolean(),
  // Whether the person has seen the first-run choice of agents to connect.
  welcomed: z.boolean(),
})

// The settings as the runner reports them, with what it can do whatever they say.
export const runnerSettingsState = runnerSettings.extend({
  // Whether transcripts can be kept here at all: they are kept only encrypted, so not where
  // nothing protects their key, as a Linux desktop with no keyring or a runner on its own.
  transcriptsAvailable: z.boolean(),
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

// Why an addon is installing: the person asked, or the app updated and brought a new engine,
// which is fetched alone and needs nothing from the person.
export const installOrigin = z.enum(["person", "update"])

// What an install is doing: downloading the engine or the model, or checking that they
// transcribe, with the bytes received of the step's total.
export const voiceInstall = z.strictObject({
  origin: installOrigin,
  model: voiceModel,
  step: z.enum(["engine", "model", "check"]),
  received: z.int().nonnegative(),
  total: z.int().nonnegative(),
})

// How the engine did on a test clip after an install: the model checked and how long a clip
// took.
export const voiceCheck = z.strictObject({
  model: voiceModel,
  milliseconds: z.int().nonnegative(),
})

export const voiceState = z.strictObject({
  // Whether this build has an engine for this platform; without one nothing installs.
  available: z.boolean(),
  // The models on disk beside the engine; empty until an install finishes.
  installed: z.array(voiceModel),
  // Whether the person turned voice input on; it needs `model` installed.
  enabled: z.boolean(),
  // Whether the person wants voice input, installed or not: until they turn it off, the
  // app offers it, as a microphone that leads to its install.
  wanted: z.boolean(),
  model: voiceModel,
  // Whether the engine for this build is on disk, which an install skips and an uninstall frees.
  engineInstalled: z.boolean(),
  // The model an install fetches first: turbo, or small where this computer is known not
  // to suit turbo. The person does not choose it.
  aim: voiceModel,
  language: voiceLanguage,
  // Download sizes in bytes: the engine for this platform, and each model.
  sizes: z.strictObject({ engine: z.int().nonnegative(), turbo: z.int(), small: z.int() }),
  installing: voiceInstall.nullable(),
  check: voiceCheck.nullable(),
  // Why the last install, or the engine's update, failed, until the next install, update
  // or removal. A clip that fails to transcribe is its caller's error alone.
  failure: z.string().max(1024).nullable(),
})

// Murmur: a small model that runs on this machine's graphics and writes terminals' titles,
// opt-in from Preferences like voice input. It has one engine and one model.

// What an install is doing: downloading the engine or the model, or checking that they
// describe, with the bytes received of the step's total.
export const murmurInstall = z.strictObject({
  step: z.enum(["engine", "model", "check"]),
  received: z.int().nonnegative(),
  total: z.int().nonnegative(),
  // Who started it: the person, or the app's update, which fetches a new engine alone.
  origin: installOrigin,
})

// The device that passed the check after an install: its name, whether it is an
// integrated GPU, and how long the test description took.
export const murmurCheck = z.strictObject({
  device: z.string().max(256),
  integrated: z.boolean(),
  milliseconds: z.int().nonnegative(),
})

export const murmurState = z.strictObject({
  // Whether this build has an engine for this platform; without one nothing installs.
  available: z.boolean(),
  // Whether the engine and the model are on disk; false until an install finishes.
  installed: z.boolean(),
  // Whether the model is on disk though murmur isn't installed (the engine is gone): a
  // verdict kept a model that was downloaded earlier, so trying again fetches the engine
  // alone. The person can remove it with an uninstall.
  kept: z.boolean(),
  // Whether the person turned murmur on; it needs to be installed.
  enabled: z.boolean(),
  // Whether the person wants murmur, installed or not: until they turn it off, the app
  // offers it.
  wanted: z.boolean(),
  // Download sizes in bytes: the engine for this platform, and the model.
  sizes: z.strictObject({ engine: z.int().nonnegative(), model: z.int().nonnegative() }),
  installing: murmurInstall.nullable(),
  // Null until a check passes.
  check: murmurCheck.nullable(),
  // Why this computer can't run murmur, technical and for a details view, once it is known:
  // the host saw only software rendering (`source: "host"`), or an install found no graphics
  // device that runs the model, or the engine could not load a library it needs
  // (`source: "check"`; the engine and the downloads are then removed, but a model that was
  // on disk before that install began stays, see `kept`). Null while nothing says it can't. It
  // is no failure to try again. An install is refused while the host's word holds; a check's
  // verdict stands until another check passes, which installing again runs, and an engine of
  // another build forgets it.
  unsupported: z
    .strictObject({ reason: z.string().max(1024), source: z.enum(["host", "check"]) })
    .nullable(),
  // In how many sessions of the app the one-time offer was shown; the app stops offering after
  // three, whether or not they answered.
  offers: z.int().nonnegative(),
  // Why murmur is not working, in words for the person: the last install or engine update
  // that failed (network, disk), until the next install, update or removal; the device it was
  // checked on being gone (the check is then null, and Try again installs just the check); a
  // worker that would not start; or the engine failing three jobs in a row (the check stands)
  // until a job succeeds. Turning murmur on clears the last two.
  failure: z.string().max(1024).nullable(),
  // The part of `failure` that is murmur stopping while installed: the engine failing three
  // jobs in a row, or its worker not starting, until a job succeeds. Null otherwise, also
  // for an install or update that failed and for a device that went away. Murmur's jobs
  // retry by themselves, so there is nothing to retry.
  stopped: z.string().max(1024).nullable(),
})

export const murmurSettings = z.strictObject({
  enabled: z.boolean(),
})

/**
 * Why `companions.save` can't write a plan, in `PLAN_UNWRITABLE`'s data, which retrying
 * won't change until the plan or its folder does:
 * - `gone`: the plan's file is no longer there.
 * - `folder`: Novadeck may not write in the plan's folder or file.
 * - `transcript`: the plan lives in an agent's messages, not a file.
 * - `too-large`: the plan is past what Novadeck writes (256 KiB).
 * - `not-a-plan`: the item is no plan.
 */
export const planUnwritable = z.strictObject({
  reason: z.enum(["gone", "folder", "transcript", "too-large", "not-a-plan"]),
})
export type PlanUnwritable = z.infer<typeof planUnwritable>

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
 * Why voice input cannot be used, as the data of VOICE_UNAVAILABLE: this build has no
 * engine for the platform, voice input is off or its model is not installed, it is being
 * removed, its engine is updating with none usable, or its engine is missing.
 */
export const voiceUnavailable = z.strictObject({
  reason: z.enum(["unavailable", "off", "removing", "updating", "missing"]),
})

export const voiceSettings = z.strictObject({
  enabled: z.boolean(),
  model: voiceModel,
  language: voiceLanguage,
})

// What the person changes of the settings: the model is the install's choice, not theirs.
export const voiceChange = voiceSettings.omit({ model: true }).partial()

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
  text: z.string().max(65_536),
  sentAt: z.number(),
  state: messageState,
  held: z.enum(["paused", "release"]).nullable(),
  deliveredAt: z.number().nullable(),
  // Only the runner creates Inbox history and responses. Ordinary agent mail has none.
  inbox: z.enum(["ask", "tell", "answer"]).optional(),
  inboxState: z.enum(["open", "answered", "read", "withdrawn", "gone", "undelivered"]).optional(),
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
  // Whether the person's stop of it is in force: a send between the pair is refused, for 10
  // minutes after the later of the stop and its last message.
  stopped: z.boolean(),
  messages: z.array(agentMessage).max(1000),
})

// Why the doorbell can't ring an idle agent whose messages wait, as it saw: its activity
// saying a turn runs (`working`), a prompt the harness shows queued (`queued`), its box in
// shell mode (`shell`), text in its input box (`draft`), a dialog, picker or other screen
// that isn't its prompt (`dialog`), a question it waits on the person for (`asking`), rings
// that failed (`failed`), or a terminal not at the agent's prompt (`away`).
export const deliveryWaits = z.enum([
  "working",
  "queued",
  "shell",
  "draft",
  "dialog",
  "asking",
  "failed",
  "away",
])

// How long a message may wait for an idle agent, the agent idle all along, before the hold is
// raised: an Inbox item for the person, and a word to its sender, in milliseconds.
export const longHoldMs = 3 * 60_000

// `messages.list`: a terminal's handle, how its agent can take messages now, why the doorbell
// can't ring it if it is idle (`waits`), since when the longest-held message for its idle
// agent has waited (`waitsSince`, epoch milliseconds: the later of when the agent last went
// idle and when the message last came to wait; null with none), whether messaging is
// paused, and every thread it is in, latest first.
export const terminalMessages = z.strictObject({
  terminalId: id,
  handle,
  delivery: deliveryState,
  waits: deliveryWaits.nullable(),
  waitsSince: z.number().int().nonnegative().nullable(),
  paused: z.boolean(),
  threads: z.array(messageThread).max(1000),
})

export type Project = z.infer<typeof project>
export type WorkspaceSession = z.infer<typeof workspaceSession>
export type TerminalExit = z.infer<typeof exit>
export type ForegroundProcess = z.infer<typeof foregroundProcess>
export type TerminalSummary = z.infer<typeof terminalSummary>
export type TitleSource = z.infer<typeof titleSource>
export type TerminalChange = z.infer<typeof terminalChange>
export type ItemHolder = z.infer<typeof itemHolder>
export type CompanionItem = z.infer<typeof companionItem>
export type CompanionWindow = z.infer<typeof companionWindow>
export type CompanionChange = z.infer<typeof companionChange>
export type ItemContent = z.infer<typeof itemContent>
export type PageTrouble = z.infer<typeof pageTrouble>
export type PlanSaveResult = z.infer<typeof planSaveResult>
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
export type ToolRun = z.infer<typeof toolRun>
export type RequestDialog = z.infer<typeof requestDialog>
export type RequestAnswer = z.infer<typeof requestAnswer>
export type TranscriptChange = z.infer<typeof transcriptChange>
export type AgentIntegration = z.infer<typeof agentIntegration>
export type RunnerSettings = z.infer<typeof runnerSettings>
export type RunnerSettingsState = z.infer<typeof runnerSettingsState>
export type VoiceModel = z.infer<typeof voiceModel>
export type VoiceInstall = z.infer<typeof voiceInstall>
export type InstallOrigin = z.infer<typeof installOrigin>
export type VoiceCheck = z.infer<typeof voiceCheck>
export type VoiceState = z.infer<typeof voiceState>
export type VoiceUnavailable = z.infer<typeof voiceUnavailable>
export type VoiceSettings = z.infer<typeof voiceSettings>
export type VoiceChange = z.infer<typeof voiceChange>
export type VoiceTranscript = z.infer<typeof voiceTranscript>
export type MurmurInstall = z.infer<typeof murmurInstall>
export type MurmurCheck = z.infer<typeof murmurCheck>
export type MurmurState = z.infer<typeof murmurState>
export type MurmurSettings = z.infer<typeof murmurSettings>
export type MessageState = z.infer<typeof messageState>
export type DeliveryState = z.infer<typeof deliveryState>
export type DeliveryWaits = z.infer<typeof deliveryWaits>
export type AgentMessage = z.infer<typeof agentMessage>
export type MessageThread = z.infer<typeof messageThread>
export type TerminalMessages = z.infer<typeof terminalMessages>

/**
 * What `agents.interrupt` gives back: the words the person had queued behind the turn that
 * the agent's input box took back as the turn was stopped (Claude Code and Antigravity
 * hand queued messages back for editing), now cleared out of the box, which the chat puts
 * back in the person's draft; null when there were none, and always for Codex, whose
 * queued message goes to the agent as a steer.
 */
export const interruptResult = z.strictObject({ returned: z.string().nullable() })
export type InterruptResult = z.infer<typeof interruptResult>
