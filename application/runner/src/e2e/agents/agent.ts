import type { AgentName } from "@novadeck/protocol"

import type { DeckTerminal } from "../deck.js"
import type { Dialect } from "../model/dialect.js"
import type { Call, Reply, Rule } from "../model/script.js"
import type { FakeModel } from "../model/server.js"
import type { Sandbox } from "../sandbox.js"

/**
 * How a test may seed a harness differently from the default, which starts it trusted
 * and straight at its prompt. A harness with no such step ignores the option.
 */
export type Seed = {
  /** False: the project folder is not trusted, so the harness asks first. */
  readonly folderTrusted?: boolean
  /** False: Novadeck's hooks are not trusted (Codex's "Hooks need review"), so they don't run. */
  readonly hooksTrusted?: boolean
  /**
   * True: the account seeded as one the harness's `popup` may show for, where it shows it
   * only for some (Claude Code's cost warning, only for a billing admin).
   */
  readonly popup?: boolean
}

/**
 * What a harness shows when a `Seed` leaves something untrusted, for the steps it has: a
 * harness without the step leaves its part out, ignores that seed, and the scenario
 * needing it skips.
 */
export type Trust = {
  /** With `folderTrusted: false`: its question about the project folder. */
  readonly folder?: FolderQuestion
  /**
   * With `hooksTrusted: false`: the screen asking to review Novadeck's hooks (`shows`),
   * when the harness shows one, and the keys that leave it without trusting them
   * (`skip`, pressed without Enter). Its hooks then don't run, so no session binds.
   */
  readonly hooks?: { readonly shows: RegExp; readonly skip: string }
}

/** A folder-trust question, as a scenario answers it. */
export type FolderQuestion = {
  /** Text the question shows, whatever is selected. */
  readonly shows: RegExp
  /**
   * The keys that select the option trusting the folder, pressed without Enter (Down),
   * or "" when the question shows that option selected and needs no key (and no `probe`).
   */
  readonly select: string
  /** That option as the screen shows it selected, which `confirm` takes. */
  readonly trusts: RegExp
  /**
   * For a TUI that draws the question before it reads keys, and drops the Enter pressed
   * then: `away` selects another option (Down), `moved` is the screen showing it
   * selected. A key seen to take proves the TUI reads, so `select` pressed after puts
   * the selection back, and the Enter that follows lands. It needs a `select` that isn't
   * "", which is what puts the selection back.
   */
  readonly probe?: { readonly away: string; readonly moved: RegExp }
}

/** The traits a scenario may need of a setup, which a harness may not have. */
export type Trait =
  | "approval"
  | "background"
  | "background.command"
  | "idleCommand"
  | "trust.folder"
  | "trust.hooks"
  | "shell"
  | "rewind"
  | "popup"
  | "questions"
  | "multiSelect"
  | "plan"
  | "forms"
  | "fork.picker"
  | "fork.inPlace"

/**
 * How a scenario makes the harness ask the person before a tool runs, and what that
 * question looks like, so the same scenario runs for every harness.
 */
export type Approval = {
  /**
   * A reply that has the agent call a tool its harness asks the person about before
   * running it, as seeded (a shell command no setting allows), given the call it answers.
   */
  readonly request: (call: Call) => Reply
  /** Text the question shows while it waits, for `confirm` and for telling it is up. */
  readonly shows: RegExp
  /** The keys that refuse it, pressed without Enter. */
  readonly deny: string
  /** What the screen shows once it is refused, the harness's own account of the refusal. */
  readonly denied: RegExp
}

/** A question a scenario has the agent ask the person, in the words of any harness's tool. */
export type Question = {
  readonly question: string
  readonly header: string
  readonly options: readonly { readonly label: string; readonly description: string }[]
  readonly multiSelect: boolean
}

/**
 * How a scenario has the agent ask the person questions with its own tool (Claude Code's
 * AskUserQuestion, Codex's request_user_input, Antigravity's ask_question), which the chat
 * answers.
 */
export type Asking = {
  /** A reply that asks `questions` through the tool, given the call it answers. */
  readonly questions: (call: Call, questions: readonly Question[]) => Reply
  /**
   * Whether it lets the person pick several options of a question (the `multiSelect`
   * trait); one that doesn't has its tool take one.
   */
  readonly multiSelect: boolean
  /** Puts a started terminal into the mode its tool needs (Codex offers it in Plan mode only). */
  readonly enter?: (terminal: DeckTerminal) => Promise<void>
}

/**
 * How a scenario has the agent call an MCP tool that asks the person to fill a form (an
 * elicitation), which the chat accepts with values or declines.
 */
export type Forms = {
  /**
   * Registers `server`, the stdio MCP server of `mcp-elicit-server.mjs`, in the harness
   * (its `elicit` tool, allowed without asking), before any terminal starts.
   */
  readonly prepare: (sandbox: Sandbox, server: string) => void
  /** A reply that calls the server's `elicit` tool, given the call it answers. */
  readonly ask: (call: Call) => Reply
}

/**
 * How a scenario has the agent propose a plan the person reviews, which the chat approves
 * or rejects with feedback.
 */
export type Planning = {
  /** Seeds the sandbox before any terminal starts: the harness in its planning mode. */
  readonly seed?: (sandbox: Sandbox) => void
  /** Puts a started terminal into planning (Codex's `/plan`). */
  readonly enter?: (terminal: DeckTerminal) => Promise<void>
  /** Rules that have the agent answer `prompt` with a plan for review, given the sandbox. */
  readonly rules: (sandbox: Sandbox, prompt: string) => readonly Rule[]
  /** What the agent's next call holds once the person approved the plan. */
  readonly approved: RegExp
}

/**
 * How a scenario has the agent start work that runs on after its turn ends, as a
 * background subagent or task, so its end can wake the agent again.
 */
export type Background = {
  /** A reply that has the agent start background work, given the call it answers. */
  readonly start: (call: Call) => Reply
  /** Whether a call is the background work's own, rather than the agent's turn. */
  readonly owns: (call: Call) => boolean
  /**
   * A reply that has the agent run `command` through its shell tool in the background,
   * without asking, its turn going on and ending while it runs, given the call it answers.
   */
  readonly command?: (call: Call, command: string) => Reply
}

/**
 * How a scenario has the agent run a command through its shell tool without asking, as
 * its seed allows, unlike `approval`'s command: a nested run of the harness itself
 * inside the agent's turn.
 */
export type Shell = {
  /**
   * A reply that has the agent run `command` through its shell tool, given the call it
   * answers, waiting for it to finish. Only a command the seed allows runs without
   * asking: `nested`'s.
   */
  readonly run: (call: Call, command: string) => Reply
  /**
   * The command that runs the harness once, non-interactively, on `prompt` and prints its
   * answer (`claude -p`, `codex exec`, `agy -p`), which its seed lets `run` run unasked.
   * It inherits the agent's environment, so it reaches the fake model too. `prompt` is
   * plain words, with no quotes.
   */
  readonly nested: (prompt: string) => string
}

/**
 * How the person forks a session: its conversation goes on in a session of its own, the
 * parent left as it was.
 */
export type Fork = {
  /**
   * Starting the harness with `command` in a new terminal shows a picker of the project's
   * sessions, latest first, Down selecting the next, and forks the one picked.
   * `picked(prompt)` matches, as selected, the row of the session whose first prompt was
   * `prompt`, for `confirm`.
   */
  readonly picker?: { readonly command: string; readonly picked: (prompt: string) => RegExp }
  /** The command, typed at its prompt, that forks its conversation in place. */
  readonly inPlace?: string
}

/**
 * A popup the harness raises by itself once its turn has ended, a menu waiting on the
 * person, which the fake model can bring about.
 */
export type Popup = {
  /**
   * A reply ending the turn with `text` that makes the harness raise the popup once the
   * turn has ended, through what the API reports beside it (its usage, its rate limits).
   */
  readonly reply: (text: string) => Reply
  /** What the popup shows, its first option selected. */
  readonly shows: RegExp
}

/**
 * What the person opens with Esc-Esc at an idle prompt (two Escapes about 300 ms apart):
 * a picker or mode for going back to an earlier prompt. Escape is a neutral key, so the
 * terminal stays Settled and a ring reaches the test paste with it open.
 */
export type Rewind = {
  /** What the screen shows while it is open. */
  readonly shows: RegExp
  /**
   * Whether it swallows a paste, so the ring fails and nothing is pressed (true), or the
   * paste leaves it and lands in the prompt, so the ring goes on as at an empty prompt
   * (false).
   */
  readonly swallows: boolean
}

/**
 * One harness, as an end-to-end test runs it: its pinned program, pointed at the fake
 * model, in a sandbox of its own, starting straight at its prompt with Novadeck's plugin
 * connected.
 */
export type AgentSetup = {
  readonly agent: AgentName
  /** The product's name, as a scenario names its tests: "Claude Code", "Codex", "Antigravity". */
  readonly name: string
  readonly dialect: Dialect
  /** What its first screen shows once it is at its prompt. */
  readonly banner: string | RegExp
  /**
   * Whether a session binds as soon as it is at its prompt, before any prompt: Claude Code
   * reports its session as it starts; Codex and Antigravity only with their first prompt.
   */
  readonly bindsAtReady: boolean
  /**
   * Hosts it tries through the proxy on every run, which no setting turns off: their
   * refused tunnels are expected. Any other refused tunnel is not.
   */
  readonly refused: readonly string[]
  /**
   * What the tripwire watches of the harness in the developer's home, relative to it.
   * `searched` are configuration files their own sessions rewrite as they start or run,
   * read and searched only for the sandbox's root, which only a connect or trust that
   * leaked out of the sandbox would write there. `listed` are folders whose entries'
   * names are searched for the sandbox's name. `stamped` are paths whose modification time
   * and size alone are compared, never their contents: a login, which is never read, and
   * plugin folders that change only when a plugin is installed or removed.
   */
  readonly watch: {
    readonly searched: readonly string[]
    readonly listed: readonly string[]
    readonly stamped: readonly string[]
  }
  /**
   * Seeds the harness's configuration inside the sandbox, so it starts at its own prompt
   * with no trust, onboarding, sign-in, update or key screen, for the version installed.
   * Returns what the sandbox's environment gains for it: its config home, the fake
   * model's address and the fake credential. The test's deck then connects Novadeck's
   * plugin through the harness's own commands, with that environment, as the Connect
   * button does.
   */
  readonly prepare: (
    sandbox: Sandbox,
    model: FakeModel,
    installed: { readonly version: string },
    seed?: Seed,
  ) => Promise<Readonly<Record<string, string>>>
  /** How it asks before a tool runs. */
  readonly approval?: Approval
  /** How its agent asks the person questions. */
  readonly asking?: Asking
  /** How its agent calls an MCP tool that elicits a form. */
  readonly forms?: Forms
  /** How its agent proposes a plan for the person's review. */
  readonly planning?: Planning
  /** How its agent starts work that outlives its turn. */
  readonly background?: Background
  /** How its agent runs a command, a nested run of the harness, without asking. */
  readonly shell?: Shell
  /** A command its prompt runs that submits nothing to the model, as `/status`. */
  readonly idleCommand?: string
  /** How the person forks a session, in a new terminal or in place. */
  readonly fork?: Fork
  /** What Esc-Esc opens at its idle prompt, and what it does with a paste. */
  readonly rewind?: Rewind
  /** A popup it raises by itself after its Stop, seeded `popup: true`. */
  readonly popup?: Popup
  /**
   * What the screen shows once Escape has interrupted the turn of `prompt` before its
   * reply came, the harness's own account of the interruption.
   */
  readonly interrupted: (prompt: string) => RegExp
  /** What it shows when a seed leaves the folder or Novadeck's hooks untrusted. */
  readonly trust?: Trust
  /**
   * Why it has none of a trait it lacks: the harness doesn't have the behaviour, as a
   * probe of the pinned version found, which the skipped test's name carries. Never a
   * gap in Novadeck's support of it: that goes to `known-gaps.ts`, raised as a blocker.
   * `lacking` fails on a missing trait with no reason here.
   */
  readonly absent?: Readonly<Partial<Record<Trait, string>>>
  /**
   * Finishes what only the connected plugin makes possible, before any harness starts:
   * Codex trusts Novadeck's hooks, whose hashes are of the hooks the plugin installed.
   */
  readonly connected?: (sandbox: Sandbox, model: FakeModel, seed?: Seed) => Promise<void>
  /**
   * The hosts of the harness's real API and login, which no request may even try to
   * reach: one that does fails the test, as the fake model was bypassed.
   */
  readonly hosts?: readonly string[]
}
