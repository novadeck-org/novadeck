// What the terminals side asks of murmur, and nothing of how it answers: the service
// behind it owns the model, the prompt, redaction and validation, and the terminals own
// when to ask and what to build a digest from.

/** What murmur is shown of a terminal running an agent: its agent's own summary, alone. */
export type AgentDigest = {
  readonly kind: "agent"
  /**
   * The project's name. The model is not shown it (the person sits in that project already);
   * it is taken out of the title it writes.
   */
  readonly project: string | null
  /** The agent's latest summary of its work, from `summarize`. */
  readonly summary: string
}

/** What murmur is shown of a plain shell. */
export type ShellDigest = {
  readonly kind: "shell"
  /** Not shown to the model, only taken out of the title it writes, as for an agent. */
  readonly project: string | null
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
}

export type Digest = AgentDigest | ShellDigest

/** Everything murmur may be shown: what the worker redacts and writes a chat for. */
export type Input = Digest

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
