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
  /** The project's name. */
  readonly project: string | null
  /** The last segment or two of the terminal's directory. */
  readonly folder: string | null
  readonly branch: string | null
  /** The title of the agent's plan. */
  readonly plan: string | null
  /** The busiest folders it writes in, at most 3, short. */
  readonly folders: readonly string[]
  /** The person's prompts, oldest first; the last is the current one. */
  readonly prompts: readonly string[]
  /** The tail of the agent's last reply. */
  readonly reply: string | null
  /** The agent's own latest summary of its work, from `summarize`: written with full context, the strongest input. */
  readonly summary: string | null
  readonly previous: Previous
}

/** What murmur is shown of a plain shell. */
export type ShellDigest = {
  readonly kind: "shell"
  readonly project: string | null
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
  readonly previous: Previous
}

export type Digest = AgentDigest | ShellDigest

/** A terminal's title, written by murmur and already validated. */
export type Description = { readonly title: string }

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
