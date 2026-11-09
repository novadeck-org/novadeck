import { withoutDoorbellLines } from "@novadeck/harness-core/prompts"
import { promptRefusal } from "@novadeck/protocol"
import {
  BoxNotCleared,
  isPlaced,
  placedWords,
  placesFit,
  Interrupts as Interrupter,
  PromptRefusal,
  Prompts as Prompter,
  WordsTaken,
  type InputEntry,
  type InputQueue,
  type InterruptHost,
  type InterruptOptions,
  type PromptGiven,
  type PromptHost,
  type PromptMode,
  type PromptOptions,
} from "@novadeck/tui-input"

import { DomainError, type ConflictReason } from "../errors.js"
import { splitImages } from "./image-marks.js"

// The library's refusals as the contract's errors, with the wording clients read. Where
// the library's timing was tuned on real agents: the wait for a first prompt's session
// (Antigravity 1.2.14 lost a first prompt given 160 ms before its session bound), an
// interrupt's waits for a queued turn (Codex's began 0.8 s after the first Escape on
// Windows CI) and between its clearing keys (a second pair on a busy Windows machine opened
// Claude Code's rewind picker), and the hold on resizes past a turn's start (Codex crashes
// on one).

const conflict = (reason: ConflictReason, message: string, cause: PromptRefusal): DomainError =>
  new DomainError("CONFLICT", message, undefined, reason, { cause })

/** The wire error for a prompt the library refused. */
export const promptError = (refusal: PromptRefusal): DomainError => {
  switch (refusal.reason) {
    case "refused":
      return new DomainError("PROMPT_REFUSED", refusal.message, undefined, undefined, {
        cause: refusal,
      })
    case "unrunnable":
      return new DomainError(
        "PROMPT_REFUSED",
        "The agent's shell runs only a command's first line, and these lines can't be joined to run as written: a remark or label (rem, ::, :label), a % variable, which cmd would expand for every line at once, an unpaired double quote, a line ending in ^, (, & or |, or one starting with ), & or |. Send it as one line, or run it in the terminal.",
        undefined,
        undefined,
        { cause: refusal },
      )
    case "gone":
      return new DomainError("TERMINAL_NOT_FOUND", undefined, undefined, undefined, {
        cause: refusal,
      })
    case "no-paste":
      return conflict("no-paste", "The agent's screen takes no bracketed paste.", refusal)
    case "no-box":
      return conflict("no-box", "The agent's input box is not on its screen.", refusal)
    case "shell-mode":
      return conflict(
        "shell",
        "The agent's input box is in its shell mode, and what it holds can't be taken out.",
        refusal,
      )
    case "draft":
      return conflict(
        "draft",
        "The agent's input box holds text already: a draft the prompt would merge into.",
        refusal,
      )
    case "command":
      return conflict("command", "The agent's input box holds a command of its own.", refusal)
    case "too-tall":
      return conflict(
        "too-tall",
        "The message is too tall for the agent's input box on this screen: make the terminal larger or the message shorter.",
        refusal,
      )
    case "ringing":
      return conflict("ringing", "A message's doorbell is ringing the agent.", refusal)
    case "not-switched":
      return new DomainError(
        "PROMPT_FAILED",
        "The agent's input box did not switch to its shell mode.",
        undefined,
        undefined,
        { cause: refusal },
      )
    case "not-shown":
      return new DomainError(
        "PROMPT_FAILED",
        "The prompt did not show in the agent's input box.",
        undefined,
        undefined,
        { cause: refusal },
      )
    case "image-not-shown":
      return new DomainError(
        "PROMPT_FAILED",
        "The agent did not take the image: it never showed it in its input box.",
        { reason: "image-not-shown" },
        undefined,
        { cause: refusal },
      )
    case "unexpanded":
      return new DomainError(
        "PROMPT_FAILED",
        "The agent shows a command this long as a placeholder, which its shell would run as text: it stays in its box, unsent. Clear it in the terminal, or send a shorter command.",
        undefined,
        undefined,
        { cause: refusal },
      )
  }
}

/** What the library threw, as the contract's error; anything else as it is. */
const domainOf = (error: unknown): unknown => {
  if (error instanceof PromptRefusal) return promptError(error)
  if (error instanceof BoxNotCleared)
    return new DomainError(
      "BOX_NOT_CLEARED",
      "The turn is stopped, but the agent's input box holds the message you queued.",
      undefined,
      undefined,
      { cause: error },
    )
  return error
}

/**
 * What the library threw as what the contract says. The words a prompt took out of the box
 * before it failed go with the error, for a client to put back; only one of a terminal gone,
 * whose draft went with it, carries none.
 */
export const asFailure = (error: unknown): unknown => {
  if (!(error instanceof WordsTaken)) return domainOf(error)
  const { returned } = error
  const failure = domainOf(error.failure)
  if (!(failure instanceof DomainError)) return failure
  if (failure.code !== "CONFLICT" && failure.code !== "PROMPT_FAILED") return failure
  const { code, message, reason } = failure
  const data = { ...(reason && { reason }), returned }
  return new DomainError(code, message, data, reason, { cause: failure })
}

/** What the library throws, as the contract's errors; anything else passes as it is. */
const asDomain = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work
  } catch (error) {
    throw asFailure(error)
  }
}

/**
 * The words ahead of an image that would leave a picker open: `@name` or `$name` at the very
 * end of the run, with the image's path pasted right after it. The whole text's end is judged
 * by `promptRefusal` already, and white space after a mention closes its picker, so only a run
 * that ends in one is refused. Throws a `PromptRefusal` for it, before any key.
 */
const imageRefusal = (text: string, images: number, at: readonly number[]): void => {
  if (!isPlaced(at) || !placesFit(text, images, at)) return
  const runs = placedWords(text, at)
  for (const run of runs.slice(0, images)) {
    if (/(?:^|\s)@\S*$/.test(run) || /(?:^|\s)\$(?:[A-Za-z_]\S*)?$/.test(run))
      throw new PromptRefusal(
        "refused",
        "An image can't follow an @ or $ mention: the agent would offer a file or skill to pick.",
      )
  }
}

/**
 * The library's `Prompts` with this app's rule for what a prompt may hold (`promptRefusal`,
 * which the clients apply too) and its errors as the contract's (see `agents.prompt`). A
 * subclass, so that the manager's tests can still replace the one step they are not about,
 * `give`, on the instance the manager holds.
 */
export class Prompts extends Prompter {
  constructor(host: PromptHost, queue: InputQueue, options: Omit<PromptOptions, "refuse"> = {}) {
    // The app's rule is last, so that no caller's option replaces it.
    super(host, queue, { ...options, refuse: (text) => promptRefusal(text, { shell: true }) })
  }

  override async prompt(
    terminalId: string,
    text: string,
    mode?: PromptMode,
    joined?: () => void,
    images?: readonly string[],
    at?: readonly number[],
  ): Promise<PromptGiven> {
    return await asDomain(
      (async () => {
        if (images && at) imageRefusal(text, images.length, at)
        return await super.prompt(terminalId, text, mode, joined, images, at)
      })(),
    )
  }

  override async promptIn(entry: InputEntry, terminalId: string, text: string): Promise<void> {
    return await asDomain(super.promptIn(entry, terminalId, text))
  }
}

/**
 * What an interrupt gave back: the words queued behind the turn, null for none, and how many
 * images were in the box with them and where (see `splitImages`), whose files the caller knows.
 */
export type Interrupted = {
  readonly returned: string | null
  readonly marks: number
  /** Where each of the marks stood among the words (see `splitImages`). */
  readonly places: readonly number[]
  /** How many images led the turn's own prompt, put back in the box and cleared. */
  readonly restored: number
}

/** The library's `Interrupts` with its errors and result as the contract's (`agents.interrupt`). */
export class Interrupts {
  private readonly interrupts: Interrupter

  constructor(host: InterruptHost, options: InterruptOptions = {}) {
    this.interrupts = new Interrupter(host, options)
  }

  /**
   * `entry`, its turn in the terminal's input queue, holds the person's keys as the box is
   * cleared. `gave` hears the words as the box held them, doorbell lines and all.
   */
  async interrupt(
    terminalId: string,
    entry?: InputEntry,
    gave?: (words: string) => void,
  ): Promise<Interrupted> {
    const { returned, images } = await asDomain(this.interrupts.interrupt(terminalId, entry))
    if (returned) gave?.(returned)
    const { words, marks, places } = splitImages(returned ?? "")
    return {
      returned: (words && withoutDoorbellLines(words)) || null,
      marks,
      places,
      restored: images ?? 0,
    }
  }
}
