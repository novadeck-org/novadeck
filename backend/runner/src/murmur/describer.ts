// What the terminals side asks of murmur, and nothing of how it answers: the service
// behind it owns the model, the prompt, redaction and validation, and the terminals own
// when to ask and what to build a digest from.

/** The title murmur last gave a terminal, shown to it again for stability. */
export type Previous = { readonly title: string } | null

/** What murmur is shown of a terminal running an agent. */
export type AgentDigest = {
  readonly kind: "agent"
  /** The agent's program, such as "Claude Code". */
  readonly harness: string
  /**
   * The project's name. The model is not shown it (the person sits in that project already);
   * it is taken out of the title it writes.
   */
  readonly project: string | null
  /** The last segment or two of the terminal's directory. */
  readonly folder: string | null
  readonly branch: string | null
  /** The title of the agent's plan. */
  readonly plan: string | null
  /** The busiest folders it writes in, at most 3, short. */
  readonly folders: readonly string[]
  /**
   * The person's substantial prompts, oldest first: the first one, which says what the
   * session is for, then the recent ones; the last is the latest, which counts most when it
   * moves the session to other work.
   */
  readonly prompts: readonly string[]
  /** The tail of the agent's last reply. */
  readonly reply: string | null
  /** The agent's own latest summary of its work, from `summarize`: written with full context, the strongest input. */
  readonly summary: string | null
  readonly previous: Previous
  /**
   * Where the terminal's name stands: `forming` while the session's work is still taking
   * shape (its first turns, or just after a pivot), when a better name may replace the
   * previous one freely; `settled` once it has held, when it is kept unless the work changed.
   */
  readonly stage: "forming" | "settled"
}

/** What murmur is shown of a plain shell. */
export type ShellDigest = {
  readonly kind: "shell"
  /** Not shown to the model, only taken out of the title it writes, as for an agent. */
  readonly project: string | null
  /** Not shown to the model. */
  readonly folder: string | null
  /** The foreground program's command line, or its name. */
  readonly command: string | null
  /** The visible rows, trimmed, trailing blanks dropped. */
  readonly screen: readonly string[]
  /**
   * Aligned with `screen`: `continues[i]` is true when line `i` ended on a full-width row, so
   * it may go on in line `i + 1`. Redaction looks across such a boundary, and nowhere else.
   */
  readonly continues?: readonly boolean[]
  /**
   * The index in `screen` of the line the last command was typed on, as the shell
   * integration's prompt report placed it: the prompt before the current one at a prompt, the
   * current one while a program runs. Absent where that is not known, as with no shell
   * integration, or once that line has left the screen.
   */
  readonly commandAt?: number
  /** Not shown to the model: a shell is renamed on every command, so it would only be kept. */
  readonly previous: Previous
}

export type Digest = AgentDigest | ShellDigest

/** What murmur is shown of the reply that ended an agent's turn. */
export type ReplyDigest = {
  readonly kind: "reply"
  /** The whole reply when short, else its first and last 4000 characters joined by "\n…\n". */
  readonly reply: string
  /** The turn ended on an error. */
  readonly failed: boolean
}

export type NoteDigest = ReplyDigest

/** Everything murmur may be shown: what the worker redacts and writes a chat for. */
export type Input = Digest | NoteDigest

/**
 * A terminal's title, written by murmur and already validated, and whether the model judged
 * the work changed from the previous title's (always true for a plain shell's, and with no
 * previous title).
 */
export type Description = { readonly title: string; readonly changed: boolean }

export type Gist = { readonly kind: "gist"; readonly text: string }
/** A gist for a reply; already validated. */
export type Note = Gist

export type Describer = {
  /**
   * What murmur makes of `digest`:
   * - a `Description`, which is a title;
   * - `null`, when the model ran and its title was refused (a question, a greeting, a copy
   *   of an example): the digest said too little, so asking again at once will not help;
   * - `undefined`, when it did not run: murmur is off, not installed or not working, is
   *   backing off or busy giving way to voice input, or the job was dropped, superseded or
   *   aborted.
   *
   * `terminal` names the terminal asking, so that refusals are counted for it alone.
   */
  describe(
    digest: Digest,
    options: { readonly signal?: AbortSignal; readonly terminal: string },
  ): Promise<Description | null | undefined>
  /**
   * As `describe`: a `Note` (the gist of a reply), null when it ran and was refused,
   * undefined when it did not run.
   */
  note(
    digest: NoteDigest,
    options: { readonly signal?: AbortSignal; readonly terminal: string },
  ): Promise<Note | null | undefined>
  /**
   * Calls `listener` at once with whether murmur is usable now, then whenever that changes;
   * returns an unsubscribe.
   */
  watchUsable(listener: (usable: boolean) => void): () => void
  /**
   * Calls `listener` when the person turns murmur off or uninstalls it, so the titles it wrote
   * are cleared; returns an unsubscribe.
   */
  watchCleared(listener: () => void): () => void
}
