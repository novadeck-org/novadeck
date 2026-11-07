import type {
  AgentCoverage,
  AgentIntegration,
  AgentName,
  StartupScreen,
  TranscriptItem,
} from "@novadeck/protocol"
import type { BoxProfile } from "@novadeck/tui-input/box"

import type { DialogAdapter } from "./dialogs.js"
import type { HarnessEvent, PlanSource, PromptShown } from "./events.js"
import type { Dialect } from "./hook-command.js"
import type { Report } from "./report.js"
import type { Shape } from "./shapes.js"
import type { SliceProfile } from "./slices.js"

/** The reasoning efforts agents may ask for, the same words in every harness that has them. */
export const efforts = ["low", "medium", "high", "xhigh", "max"] as const
export type Effort = (typeof efforts)[number]

/** A model a harness can start with, and the efforts it takes. */
export type Model = { readonly id: string; readonly efforts: readonly Effort[] }

/** Where a harness lives on this machine, as its setup and inspection need it. */
export type Install = {
  /** The person's login environment, which may move the harness's home. */
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly platform: NodeJS.Platform
  /** Novadeck's directory holding this harness's plugin files. */
  readonly plugin: string
}

/** One of a harness's plugin commands; a failing one marked `optional` is skipped. */
export type Command = { readonly argv: readonly string[]; readonly optional?: boolean }

/** A file Novadeck writes for a harness, relative to the directory that holds it. */
export type File = { readonly path: string; readonly content: string; readonly mode?: number }

/**
 * One harness, as its own files and commands describe it. Novadeck only reads its
 * configuration; installing and removing its plugin goes through its own commands,
 * which own that configuration. A feature it lacks is a field it leaves out.
 */
export type Harness = {
  readonly id: AgentName
  /** Where Novadeck keeps its plugin, under the plugins directory. */
  readonly plugin: string
  /** Where its installer puts the program when it is not on PATH. */
  readonly fallback?: (home: string) => string
  /** Its own home, whose presence says it is installed. */
  readonly home: (install: Install) => string
  /**
   * The folders under which it keeps the plans it writes as files, beside any in a
   * project: Novadeck saves the person's edits to a plan file only there or in the
   * project's folder. None for a harness whose plans live in its messages.
   */
  readonly planFolders?: (install: Install) => readonly string[]
  /**
   * The same folders for one session, from the path of its transcript, which the session
   * itself reported: a terminal whose agent was started with another home (as a second
   * account's) keeps its plans there, which the runner's own install cannot tell.
   * Empty where the path says nothing.
   */
  readonly planFoldersOf?: (transcript: string) => readonly string[]
  /** Whether its own configuration lists Novadeck's plugin as installed. */
  readonly connected: (install: Install) => Promise<boolean>
  /** Its plugin commands, run in order. */
  readonly connect: (install: Install) => readonly Command[]
  readonly disconnect: readonly Command[]
  /**
   * The shell it runs its hook commands in on `platform` (see `hook-command.ts`), or the
   * command for `event`, as Claude Code's status line, where that runs in another.
   */
  readonly hookDialect: (platform: NodeJS.Platform, event?: string) => Dialect
  /**
   * The command its plugin runs for a hook `event`, in that shell: `hookCommand`'s, with
   * what it prints without Novadeck.
   */
  readonly hook: (platform: NodeJS.Platform, event: string) => string
  /**
   * Its plugin's manifests, hook registrations and MCP server, relative to its plugin
   * directory. The MCP server starts as `launchers.mcp` says, and the hooks as `machine`
   * lets them.
   */
  readonly files: (
    platform: NodeJS.Platform,
    launchers: Launchers,
    machine?: Machine,
  ) => readonly File[]
  /**
   * Where the agent keeps a copy of the plugin it installed, and the files of it that must
   * match Novadeck's, for a harness that copies its plugin as it installs it: where they
   * differ, as once a Novadeck renders them otherwise, the plugin is installed again.
   */
  readonly installed?: {
    readonly directory: (install: Install) => string
    readonly files: readonly string[]
  }
  /**
   * What keeps its messaging from working whole once connected, where something does, as
   * Antigravity's own status line on Windows (`AgentIntegration.limited`).
   */
  readonly limited?: (install: Install) => Promise<AgentIntegration["limited"]>
  /**
   * Changes its own settings once connected, and puts them back before disconnecting, for
   * what it offers no way to set per launch, as Antigravity's status line.
   */
  readonly settings?: {
    readonly apply: (install: Install) => Promise<void>
    readonly revert: (install: Install) => Promise<void>
  }
  /**
   * Programs Novadeck's shells put first on PATH while it is connected; `machine` is what the
   * machine does to a hook (Antigravity's shim exists only where it names a `cmdShimDir`).
   */
  readonly shims?: (platform: NodeJS.Platform, machine?: Machine) => readonly File[]
  /**
   * What shows a command starts no interactive session (see the runner's
   * `terminals/commands.ts`): its `commands` other than a session, as the first word that is
   * not an option; its help and version `flags`, anywhere; the options that `takesValue`,
   * whose next word is theirs; and those of them that `takesMany`, whose later words are
   * theirs too, up to the next option. Its `print` flags, anywhere, run it on a prompt, so
   * they make the command a session's use whatever else it has; none where it has none.
   */
  readonly nonSession: {
    readonly commands: readonly string[]
    readonly flags: readonly string[]
    readonly takesValue: readonly string[]
    readonly takesMany: readonly string[]
    readonly print: readonly string[]
  }
  /** Where its actors' transcripts are, and what each of their records says. */
  readonly transcripts?: {
    /**
     * The transcript of a session's root, or of one of its subagents by its own id, given
     * the root's; undefined when it cannot be found.
     */
    readonly locate: (
      root: string,
      sessionId: string,
      subagent: string | null,
    ) => Promise<string | undefined>
    /** The items one line of it records, oldest first; none for a line of anything else. */
    readonly items: (line: string) => readonly TranscriptEntry[]
    /**
     * The shapes one line of it holds, each read, skipped knowingly or unknown to `items`
     * (see shapes.ts): how a record a harness release added, which `items` drops without a
     * word, is caught.
     */
    readonly shapes: (line: string) => readonly Shape[]
    /**
     * Whether a shape of that key sits inside the conversation: a block of the person's or
     * the agent's message, or a step of theirs. One `shapes` calls unknown there is words
     * the chat may be missing, which it tells the person; any other unknown shape is
     * metadata, which a harness release adds often, and only the runner's log tells.
     */
    readonly conversational: (key: string) => boolean
    /**
     * Where one line stands in it, where the line says (Antigravity's `step_index`), growing
     * through the conversation though lines may come out of order: what the runner keeps an
     * interruption the transcript doesn't record against (`records` false), as a rewrite of
     * the file that keeps each step's index keeps the mark's place, where a byte offset would
     * not. None for a harness that records its own.
     */
    readonly step?: (line: string) => number | undefined
  }
  /**
   * The plans one line of its transcript or rollout records, as its own decoders read
   * them, each with when it was written: how a plan it presented as text, which no file
   * of its own holds, is read back once its hooks and activity are gone.
   */
  readonly plans?: (line: string) => readonly WrittenPlan[]
  /** How much of each feature Novadeck tells of it, from the sources its adapter reads. */
  readonly coverage: AgentCoverage
  /**
   * Whether work a turn leaves running, as a background subagent or command, wakes the
   * agent with a turn of its own once done, so it works on until then (see
   * docs/harness-coverage.md, "Activity").
   */
  readonly wakes: boolean
  /**
   * Whether it says more of how a turn ended than its Stop hook, after the person's
   * Escape: Claude Code's transcript and Codex's `Interrupt` hook and rollout record the
   * interruption or the finish, and their Stop fires for a turn they took the key just
   * after the reply of, so the Stop alone is not the end. Antigravity fires its Stop only
   * for a turn that finished, so there it is (see docs/harness-coverage.md, "Escape against
   * a reply on its way").
   */
  readonly records: boolean
  /** How it starts: plain, on a first prompt, or continuing a session, on a model of its own. */
  readonly launch: LaunchProfile
  /** How it takes part in agents' messaging: what its hooks print, and how it behaves. */
  readonly messaging: MessagingProfile
  /** How its input box reads off its screen, which a prompt checks before and after it pastes. */
  readonly box: BoxProfile
  /** Where it draws its own things at its input, for the chat's live slice. */
  readonly slice: SliceProfile
  /**
   * The variable of its hooks' environment that names its own process, as Claude Code's
   * `CLAUDE_PID`, where it sets one: the hook names the agent that ran it by that, and
   * otherwise by the nearest ancestor process of its name. The relay forwards it (the
   * runner's `hookVariables`).
   */
  readonly pidVariable?: string
  /** The normalized facts in one of its hooks' reports; none for one it ignores. */
  readonly decode: (report: Report) => readonly HarnessEvent[]
  /**
   * The session and transcript any of its hooks' reports names, where one that is not its
   * session start names them too (Claude Code's and Codex's), so a session bound without a
   * transcript learns it from a later report. Absent where its other reports already
   * observe the session with its transcript, as Antigravity's hooks do.
   */
  readonly transcriptOf?: (report: Report) => { sessionId: string; transcript: string } | undefined
  /**
   * How its TUI's dialogs for requests waiting on the person read on screen and take an
   * answer, so the chat can answer them (see `dialogs.ts`); absent where none can be.
   */
  readonly dialogs?: DialogAdapter
  /**
   * The fields of its hooks' payloads that hold a command the person may be asked to
   * approve. Reports keep these whole, where they cut all other text, as a dialog's `detail`
   * is the request's own command and a yes runs every line of it.
   */
  readonly commandFields?: readonly string[]
  /**
   * Whether one of its hooks' reports says its prompt shows before any session it names
   * has bound, as Antigravity's status line saying idle with no conversation yet.
   */
  readonly shown?: (report: Report) => PromptShown | undefined
  /**
   * Which screen one of its hooks' reports says it is at before any session, where it says:
   * the screen's look alone decides whether that holds it for the person.
   */
  readonly startupScreen?: (report: Report) => StartupScreen | undefined
  /**
   * Whether the terminal title it sets, as Novadeck's shells start it (Codex's shim names
   * the title's items), says its prompt shows. It counts only while the terminal's
   * foreground runs a process of the harness's name.
   */
  readonly title?: (title: string, at: number) => PromptShown | undefined
  /**
   * The version of the harness running, read off the rows of its screen, where it draws one
   * (Codex's banner, "OpenAI Codex (v0.166.0)", at each process's start, a resume's too);
   * undefined where they show none. It names the running release, which its records may not.
   */
  readonly screenVersion?: (rows: readonly string[]) => string | undefined
  /**
   * What its version line starts with, and within how many columns, so the runner looks at
   * a screen's rows cheaply on every draw and has `screenVersion` read only those that hold
   * it (Codex: `>_` within the first 8 columns).
   */
  readonly screenMarker?: { readonly text: string; readonly columns: number }
  /** Whether the terminal title it sets says a turn runs, as Codex's Working does. */
  readonly titleWorking?: (title: string) => boolean
  /**
   * Whether Novadeck's hooks run for it in `cwd`, where it runs them only once the person
   * trusts them (Codex): a prompt it shows counts only then, as nothing could deliver a
   * message, or confirm a ring, without them. `where` holds the terminal's own program
   * and environment where the runner can tell them. Undefined when the harness couldn't
   * answer; trusted when omitted.
   */
  readonly hooksTrusted?: (
    where: Install & { readonly program?: string },
    cwd: string,
  ) => Promise<boolean | undefined>
  /**
   * Whether the session a title shows, whose id starts with `prefix`, is one it just
   * started as a new root (Codex's /clear), not another it only shows, as a forked side
   * conversation or a spawned agent: only then does a title naming another session end
   * the bound one's binding. `holds` tells whether a process of the terminal's
   * foreground group, where the harness runs, holds a file open, where the platform
   * tells. Where omitted, nothing but the session's own hooks ends it.
   */
  readonly startedSession?: (
    where: Install,
    prefix: string,
    since: number,
    holds?: (path: string) => Promise<boolean | undefined>,
  ) => Promise<boolean>
  /**
   * The variables of its process that say where it lives and which program it runs (as
   * Codex's `CODEX_HOME`), read from the terminal's own process where the platform tells,
   * for asking it about its hooks and sessions.
   */
  readonly environment?: readonly string[]
  /**
   * Follows a bound session's own sources beyond its hooks, as its transcript, emitting
   * what they say until `signal` aborts.
   */
  readonly watch?: (
    run: Run,
    signal: AbortSignal,
    emit: (event: HarnessEvent) => void,
  ) => Promise<void>
  /**
   * Follows one of a bound session's subagents, by its id, in its own sources, for what
   * ends its turn that no hook reports, as Codex's rollout records a request dismissed
   * with Esc: from `since`, when its oldest request still waiting was asked, until
   * `signal` aborts. Novadeck follows it only while that subagent's request waits.
   */
  readonly watchActor?: (
    run: Run,
    actor: string,
    since: number,
    signal: AbortSignal,
    emit: (event: HarnessEvent) => void,
  ) => Promise<void>
}

/**
 * What a harness knows of agents' messaging (see docs/agent-messaging.md): what its hooks
 * print when they ask Novadeck, each a whole line of the JSON it reads, and how it
 * behaves, so shared code never asks which harness it is. Nothing here says how it draws
 * its screen: the doorbell's checks are the same for every TUI.
 */
export type MessagingProfile = {
  /**
   * The hook events that ask, and when each fires: as a turn ends, as a prompt starts it, or
   * as a tool call of the turn finishes (`tool`, which delivers only the lead's messages).
   */
  readonly asks: { readonly [event: string]: "stop" | "prompt" | "tool" }
  /**
   * What a hook prints with nothing to deliver, as it does without Novadeck: by event, and
   * for any other (`*`). The relay prints the same when Novadeck can't answer.
   */
  readonly silent: { readonly "*": string; readonly [event: string]: string }
  /**
   * A Stop's answer that continues the turn with a delivery, given what the Stop hook
   * reported (its `payload`), where the harness reads one shape or another by its version.
   */
  readonly stop: (delivery: string, payload?: Report["payload"]) => string
  /** A prompt's answer that adds a delivery to what the model sees, apart from the prompt. */
  readonly prompt: (delivery: string) => string
  /**
   * A tool call's answer, for the hook `event` that asked, that adds a delivery to what the
   * model reads next, beside the tool's result, while its turn runs. Present exactly where
   * `asks` has a `tool` event; Antigravity's PreInvocation asks before every model call
   * already.
   */
  readonly call?: (delivery: string, event: string) => string
  /**
   * Whether a prompt-time delivery lasts only for the model call it was printed for, so
   * each later call of the turn gets it again, as in Antigravity.
   */
  readonly reinjectPerCall: boolean
  /**
   * Whether a prompt given while a turn runs runs its prompt hook as it is queued, not as it
   * is sent. What that hook prints rides the queued prompt, which the person or a Stop may
   * still take back out of the queue, so it delivers nothing; the running turn's Stop does.
   * Omitted where the prompt hook runs with the prompt that goes to the model.
   */
  readonly promptHookOnQueueing?: true
  /**
   * Which session its messages are for: the one bound (`binding`), or, where its hooks
   * name subagents' sessions alike, the one its status line names (`status-line`).
   */
  readonly root: "binding" | "status-line"
  /**
   * The asks whose printed text stays in the session's context for its later turns, until
   * a compaction its hooks report (`compacted`): there Novadeck gives the rules note of
   * its deliveries in full once, and a short pointer after. Elsewhere, as where an
   * injection lasts one model call (Antigravity's) or no hook tells of a compaction, every
   * delivery carries the note in full.
   */
  readonly lasting: readonly ("stop" | "prompt" | "tool")[]
  /**
   * The lines that, typed and submitted at its prompt, make the agent exit, as the person
   * leaves it; the runner takes the end that follows for theirs.
   */
  readonly exitCommands: readonly string[]
  /** The key that queues the person's prompt for after the turn, as Codex's Tab. */
  readonly queueKey?: string
  /** Whether a failed turn fires nothing, so its turn may only end with its next prompt. */
  readonly silentOnFailure: boolean
  /**
   * Whether its box takes a prompt at once while only work a stopped turn left running
   * runs (background subagents and shells): the doorbell may ring it then, once its screen
   * shows the box empty. Otherwise that work holds its messages until it ends.
   */
  readonly promptsInBackground: boolean
  /**
   * Whether it takes its MCP servers' tools only as a turn starts, so a turn started before
   * Novadeck's server listed its tools has none of them to its end: the doorbell then
   * rings it only once that server has (or after a while, so a ring isn't lost), and a
   * task never starts it from its command line, whose prompt would go first.
   */
  readonly toolsAtTurnStart: boolean
  /**
   * Where its hooks name no prompt (as Antigravity's, whose every turn decodes as
   * harness-started), what one line of its transcript records as typed into its box, if
   * that is what it records: from it the runner's `typed-prompts.ts` tells a root turn's
   * prompt.
   */
  readonly typedEntry?: (line: string) => UserEntry | undefined
}

/**
 * How a harness starts in a terminal, as the words a shell runs: the program first, then the
 * model and effort `choose` puts right after it.
 */
export type LaunchProfile = {
  /** How it starts without a prompt. */
  readonly start: readonly string[]
  /**
   * How it starts with `line` as its first prompt, which it submits only once past its
   * startup screens; undefined where it may not here, as Antigravity anywhere, whose
   * prompt waits neither for its trust dialog nor for its MCP servers' tools.
   */
  readonly initialPrompt: (
    line: string,
    place: { readonly install: Install | undefined; readonly cwd: string },
  ) => Promise<readonly string[] | undefined>
  /**
   * The words that continue its session by id, with the model and effort `choose` puts,
   * where each is given: after its program, or where its resume command takes its options.
   */
  readonly resume?: (session: string, choice?: Choice) => readonly string[]
  /**
   * The models it can start with on this machine, each with the reasoning efforts it takes;
   * none where that can't be told. It runs no command.
   */
  readonly models: (install: Install) => Promise<readonly Model[]>
  /** The words that go right after its program to start it with this model and effort. */
  readonly choose: (choice: Choice) => readonly string[]
}

/** The model and reasoning effort an agent starts with; none leaves its own. */
export type Choice = {
  readonly model?: string
  readonly effort?: Effort
}

/**
 * Something a transcript recorded as typed into the agent's box: its text; when, rounded
 * down where the transcript is coarser (Antigravity's is to the second); and its place in
 * the transcript (`id`, growing with each step), where the transcript gives one.
 */
export type UserEntry = {
  readonly text: string
  readonly at: number | null
  readonly id: number | null
}

/**
 * What `profile`'s hook prints for `event` with nothing to deliver: its own answer, never
 * one an object inherits (an event named `constructor` gets the `*` answer).
 */
export const silentFor = (profile: MessagingProfile, event: string): string =>
  (Object.hasOwn(profile.silent, event) ? profile.silent[event] : undefined) ?? profile.silent["*"]

/** How an agent starts a program of Novadeck's: a file, by its absolute path, and arguments. */
export type Start = { readonly command: string; readonly args?: readonly string[] }

/**
 * How agents start what Novadeck installs for them: its MCP server, which they start
 * without a shell that could expand a variable.
 */
export type Launchers = { readonly mcp: Start }

/** What the machine does to a hook before the hook's own command runs. */
export type Machine = {
  /**
   * Whether cmd prints something of its own before any command it runs, as an AutoRun
   * (the machine's or the person's account's, `HKLM` or
   * `HKCU\Software\Microsoft\Command Processor\AutoRun`) of `chcp 65001` without `>nul`
   * does, for a harness that runs its hooks in cmd without `/d`: ahead of the hook's
   * answer, which a harness that reads it as JSON then can't.
   */
  readonly cmdPrints?: boolean
  /**
   * For a harness that runs its hooks through the `cmd` it finds on PATH: the folder (a path
   * cmd reads unquoted) holding Novadeck's `cmd.exe` pass-through, which runs the real cmd with
   * `/d` for Novadeck's own hooks, so the AutoRun does not print ahead of their answers. Its
   * shim puts the folder first on PATH for the agent alone. Set only where the pass-through
   * is installed and is the shipped one. It covers the agent in Novadeck's terminals only, so
   * `cmdPrints` stays set.
   */
  readonly cmdShimDir?: string
}

/** A plan a transcript or rollout line records, and when it was written where it says. */
export type WrittenPlan = { readonly source: PlanSource; readonly at: number | null }

/** An item of a transcript, before the runner numbers it. */
export type TranscriptEntry = Omit<TranscriptItem, "index">

/**
 * A harness's transcript decoder without its shape lists, which the harness adds beside
 * it: the lists read the decoder's own helpers, so they live in a module of their own.
 */
export type TranscriptDecoder = Omit<
  NonNullable<Harness["transcripts"]>,
  "shapes" | "conversational"
>

/** A session bound to a terminal, as a harness's `watch` follows it. */
export type Run = {
  readonly sessionId: string
  readonly instance: string | null
  /** Its transcript, as its hooks named it. */
  readonly transcript: string
}
