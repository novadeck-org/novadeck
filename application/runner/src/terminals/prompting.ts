import { promptRefusal, type InterruptResult } from "@novadeck/protocol"
import {
  BoxNotCleared,
  Interrupts as Interrupter,
  PromptRefusal,
  Prompts as Prompter,
  type InputEntry,
  type InputQueue,
  type InterruptHost,
  type InterruptOptions,
  type PromptHost,
  type PromptOptions,
} from "@novadeck/tui-input"

import { DomainError, type ConflictReason } from "../errors.js"

// The hosts and options the manager gives the two, named here beside the classes that take them.
export type { InterruptHost, InterruptOptions, PromptHost, PromptOptions }

// The library's refusals as the contract's errors, with the wording clients read. Where
// the library's timing was tuned on real agents: the wait for a first prompt's session
// (Antigravity 1.2.14 lost a first prompt given 160 ms before its session bound), an
// interrupt's waits for a queued turn (Codex's began 0.8 s after the first Escape on
// Windows CI) and between its clearing keys (a second pair on a busy Windows machine opened
// Claude Code's rewind picker), and the hold on resizes past a turn's start (Codex crashes
// on one).

const conflict = (reason: ConflictReason, message: string): DomainError =>
  new DomainError("CONFLICT", message, undefined, reason)

/** The wire error for a prompt the library refused. */
export const promptError = (refusal: PromptRefusal): DomainError => {
  switch (refusal.reason) {
    case "refused":
      return new DomainError("PROMPT_REFUSED", refusal.message)
    case "unrunnable":
      return new DomainError(
        "PROMPT_REFUSED",
        "The agent's shell runs only a command's first line, and these lines can't be joined to run as written: a remark or label (rem, ::, :label), a % variable, which cmd would expand for every line at once, an unpaired double quote, a line ending in ^, (, & or |, or one starting with ), & or |. Send it as one line, or run it in the terminal.",
      )
    case "gone":
      return new DomainError("TERMINAL_NOT_FOUND")
    case "no-paste":
      return conflict("no-paste", "The agent's screen takes no bracketed paste.")
    case "no-box":
      return conflict("no-box", "The agent's input box is not on its screen.")
    case "shell-mode":
      return conflict(
        "shell",
        "The agent's input box is in its shell mode: clear it in the terminal first.",
      )
    case "draft":
      return conflict(
        "draft",
        "The agent's input box holds text already: a draft the prompt would merge into.",
      )
    case "too-tall":
      return conflict(
        "too-tall",
        "The message is too tall for the agent's input box on this screen: make the terminal larger or the message shorter.",
      )
    case "ringing":
      return conflict("ringing", "A message's doorbell is ringing the agent.")
    case "not-switched":
      return new DomainError(
        "PROMPT_FAILED",
        "The agent's input box did not switch to its shell mode.",
      )
    case "not-shown":
      return new DomainError("PROMPT_FAILED", "The prompt did not show in the agent's input box.")
    case "unexpanded":
      return new DomainError(
        "PROMPT_FAILED",
        "The agent shows a command this long as a placeholder, which its shell would run as text: it stays in its box, unsent. Clear it in the terminal, or send a shorter command.",
      )
  }
}

/** What the library throws, as the contract's errors; anything else passes as it is. */
const asDomain = async <T>(work: Promise<T>): Promise<T> => {
  try {
    return await work
  } catch (error) {
    if (error instanceof PromptRefusal) throw promptError(error)
    if (error instanceof BoxNotCleared)
      throw new DomainError(
        "BOX_NOT_CLEARED",
        "The turn is stopped, but the agent's input box holds the message you queued: clear it in the terminal.",
      )
    throw error
  }
}

/**
 * The library's `Prompts` with this app's rule for what a prompt may hold (`promptRefusal`,
 * which the clients apply too) and its errors as the contract's (see `agents.prompt`). A
 * subclass, so that the manager's tests can still replace the one step they are not about,
 * `give`, on the instance the manager holds.
 */
export class Prompts extends Prompter {
  constructor(host: PromptHost, queue: InputQueue, options: PromptOptions = {}) {
    super(host, queue, { refuse: (text) => promptRefusal(text, { shell: true }), ...options })
  }

  override async prompt(terminalId: string, text: string): Promise<void> {
    return await asDomain(super.prompt(terminalId, text))
  }

  override async promptIn(entry: InputEntry, terminalId: string, text: string): Promise<void> {
    return await asDomain(super.promptIn(entry, terminalId, text))
  }
}

/** The library's `Interrupts` with its errors and result as the contract's (`agents.interrupt`). */
export class Interrupts {
  private readonly interrupts: Interrupter

  constructor(host: InterruptHost, options: InterruptOptions = {}) {
    this.interrupts = new Interrupter(host, options)
  }

  async interrupt(terminalId: string): Promise<InterruptResult> {
    const { returned } = await asDomain(this.interrupts.interrupt(terminalId))
    return { returned: returned ?? null }
  }
}
