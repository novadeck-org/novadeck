/** How long a hold's safety caps let it last, in milliseconds. */
export type HoldBudget = {
  /** How long the person's input is held at most. */
  readonly inputMs: number
  /** How long the window's resizes are held at most, or until `settle`. */
  readonly sizeMs: number
  /**
   * Whether the keys held count as the person's only once delivered, as an answer's hold
   * may drop them (see `discard`).
   */
  readonly deferred?: boolean
}

/** The person's input to a terminal, held for one piece of work at the agent's input box. */
export type InputHold = {
  /** Lets the person's input go on, writing the keys it held; the resizes stay held. */
  readonly release: () => void
  /** Lets the window's resizes go on too, releasing the input if it is still held. */
  readonly settle: () => void
  /**
   * Lets the window's resizes go on in `ms`, after the work's last key: a `settle` before
   * then, by this hold or by the one that takes it over, waits until then instead of
   * applying them, as a resize as a turn starts may crash a TUI.
   */
  readonly settleAfter: (ms: number) => void
  /** Whether the input is still held. */
  readonly holding: () => boolean
  /** Drops what the person typed while their input was held. */
  readonly discard: () => void
}

/** What the queue needs of the terminal manager, by terminal. */
export type InputQueueHost = {
  /**
   * Holds the person's input to the terminal for at most `budget.inputMs`, and its
   * window's resizes for at most `budget.sizeMs` or until `settle`. Never in force at the
   * same time as another's, apart from one that only waits on its resizes, whose hold
   * this one takes over. A hold on a terminal that is gone is not `holding`.
   */
  readonly hold: (terminalId: string, budget: HoldBudget) => InputHold
}

/** What a piece of work given the terminal's input may take. */
export type InputEntry = {
  /** Holds the person's input for the work, which the queue lets go of when it ends. */
  readonly hold: (budget: HoldBudget) => InputHold
}

/**
 * The one line of work at each terminal's agent input box (see docs/backend-api.md,
 * `agents.prompt`). Everything that puts keys in the box takes its turn here: prompts,
 * answers together with the words that follow them, interrupts, and the messaging
 * doorbell's rings. Entries of one terminal go one at a time, in the order they came,
 * and those of different terminals never wait for each other; so no two pieces of work
 * ever hold the person's input at once, and nothing comes between an answer and its
 * words. An entry that fails, by throwing, wedges nothing: the next one starts. Whatever
 * input an entry holds is let go when it ends, however it ends; its resizes are its own to
 * settle.
 */
export class InputQueue {
  /** The latest entry of each terminal that is not yet done. */
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly host: InputQueueHost) {}

  /** Runs `work` once the entries before it at the terminal are done; its result is the entry's. */
  async run<T>(terminalId: string, work: (entry: InputEntry) => Promise<T>): Promise<T> {
    const previous = this.tails.get(terminalId) ?? Promise.resolve()
    const run = previous.then(() => this.enter(terminalId, work))
    const tail = run.then(
      () => {},
      () => {},
    )
    this.tails.set(terminalId, tail)
    void tail.then(() => {
      if (this.tails.get(terminalId) === tail) this.tails.delete(terminalId)
    })
    return await run
  }

  private async enter<T>(terminalId: string, work: (entry: InputEntry) => Promise<T>): Promise<T> {
    const holds: InputHold[] = []
    try {
      return await work({
        hold: (budget) => {
          const hold = this.host.hold(terminalId, budget)
          holds.push(hold)
          return hold
        },
      })
    } finally {
      for (const hold of holds) hold.release()
    }
  }
}
