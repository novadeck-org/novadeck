/**
 * How a terminal's agent can take a message now, one state machine per terminal (see
 * docs/agent-messaging.md, "States"). Every terminal with an agent is in one state at
 * all times, derived from what its harness and its person did, so the prompt's emptiness
 * is known before any message arrives. Step one has no doorbell: a Settled terminal waits
 * for its next root prompt, as a Drafting (person busy) or Unknown one does.
 *
 * Working has three phases: a root `turn` running; `continuing`, after a Stop NovaDeck
 * continued, until the continuation's first prompt; and `background`, when only work a
 * turn started still runs after its Stop (Claude Code's background tasks, Antigravity's
 * subagents). Only in a turn, or continuing, is the person's Enter a prompt their harness
 * queues; in the background it submits one at once.
 */
export type Delivery = Counts &
  (
    | { readonly state: "unbound" | "fresh" | "settled" | "drafting" | "unknown" }
    | { readonly state: "working"; readonly phase: "turn" | "continuing" | "background" }
  )

/** What every state carries. */
type Counts = {
  /**
   * Counts root turns and bindings, so what was leased in one turn never acts on a later
   * one, and a later call of a turn finds what its first was given.
   */
  readonly epoch: number
  /**
   * Whether the prompt is known empty: since the session bound or the person's last
   * root prompt, the person typed nothing there, apart from answers to a request.
   */
  readonly empty: boolean
  /** Whether the person submitted a prompt during the running turn, which their harness queues. */
  readonly submitted: boolean
  /** How many of the current turn's Stops NovaDeck continued with messages. */
  readonly continued: number
}

export type DeliveryState = Delivery["state"]

/** NovaDeck continues a root turn at most this often, by its own count, then lets it end. */
export const maxContinuations = 2

/**
 * What changes a terminal's delivery:
 * - `bound`: a session binds, or its harness announced a new one;
 * - `unbound`: the binding ended, as its instance exited;
 * - `prompt`: a root turn started: the person's prompt, one the harness started by
 *   itself (a background task's result, or any Antigravity turn, whose hooks can't tell),
 *   or a later model call of a running turn;
 * - `stop`: a normal root Stop, which NovaDeck `continued` or not, with work the turn
 *   started still running in the `background`;
 * - `ended`: a root turn ended abnormally: an Esc, a denial, a failure;
 * - `idle`: the agent shows idle however its turn ended, with work still running in the
 *   `background` or not, as Antigravity's status line does;
 * - `input`: the person's input, which `submits` a prompt (Enter, or a harness's queue
 *   key, as Codex's Tab), unless it `answers` a pending request.
 */
export type DeliveryEvent =
  | { readonly type: "bound" }
  | { readonly type: "unbound" }
  | { readonly type: "prompt"; readonly by: "person" | "harness" | "call" }
  | { readonly type: "stop"; readonly continued: boolean; readonly background: boolean }
  | { readonly type: "ended" }
  | { readonly type: "idle"; readonly background: boolean }
  | { readonly type: "input"; readonly submits: boolean; readonly answers: boolean }

export const unbound: Delivery = {
  state: "unbound",
  epoch: 0,
  empty: false,
  submitted: false,
  continued: 0,
}

/** The phase of a working delivery; none otherwise. */
export const phaseOf = (delivery: Delivery): "turn" | "continuing" | "background" | undefined =>
  delivery.state === "working" ? delivery.phase : undefined

/** Whether a root turn runs: in its turn, or about to continue. */
export const running = (delivery: Delivery): boolean => {
  const phase = phaseOf(delivery)
  return phase === "turn" || phase === "continuing"
}

/** Whether a Stop may end a turn here: one running, or one whose start went unseen. */
const stoppable = (delivery: Delivery): boolean =>
  delivery.state === "working" || delivery.state === "unknown" || delivery.state === "fresh"

const counts = ({ epoch, empty, submitted, continued }: Delivery): Counts => ({
  epoch,
  empty,
  submitted,
  continued,
})

/** A turn ended normally: Settled with the prompt known empty, else the person drafting. */
const ended = (delivery: Delivery): Delivery => ({
  ...counts(delivery),
  state: delivery.empty && !delivery.submitted ? "settled" : "drafting",
  submitted: false,
  continued: 0,
})

const working = (
  delivery: Delivery,
  phase: "turn" | "continuing" | "background",
  change: Partial<Counts> = {},
): Delivery => ({ ...counts(delivery), ...change, state: "working", phase })

/** The delivery after an event; the same delivery when it changes nothing. */
export const transition = (delivery: Delivery, event: DeliveryEvent): Delivery => {
  if (event.type === "bound")
    return {
      state: "fresh",
      epoch: delivery.epoch + 1,
      empty: true,
      submitted: false,
      continued: 0,
    }
  if (event.type === "unbound") return { ...unbound, epoch: delivery.epoch + 1 }
  if (delivery.state === "unbound") return delivery
  const phase = phaseOf(delivery)
  switch (event.type) {
    case "prompt": {
      // A later call of the running turn changes nothing, nor ends the wait for the
      // continuation of a Stop NovaDeck continued: a status line saying working can come
      // before the continuation's first model call.
      if (event.by === "call" && (phase === "turn" || phase === "continuing")) return delivery
      // The person's own prompt says the prompt is empty again, and is the one they
      // submitted, so nothing of theirs is queued any more.
      const person = event.by === "person"
      // A prompt right after a Stop NovaDeck continued is that continuation: the same
      // turn, with its count, as Antigravity starts its model calls again from the first.
      if (phase === "continuing")
        return working(delivery, "turn", person ? { empty: true, submitted: false } : {})
      // A call while no turn ran (as a status line saying working after an idle one)
      // resumes the turn it belongs to, with its counts.
      if (event.by === "call") return working(delivery, "turn")
      return working(delivery, "turn", {
        epoch: delivery.epoch + 1,
        empty: person ? true : delivery.empty,
        submitted: false,
        continued: 0,
      })
    }
    case "stop": {
      if (!stoppable(delivery)) return delivery
      if (event.continued)
        return working(delivery, "continuing", { continued: delivery.continued + 1 })
      // What the turn started still runs, and may start another turn by itself.
      if (event.background)
        return working(delivery, "background", {
          empty: delivery.empty && !delivery.submitted,
          submitted: false,
          continued: 0,
        })
      return ended(delivery)
    }
    case "ended":
      // The turn's counts stay, as a Stop that raced this end is still that turn's.
      return { ...counts(delivery), state: "unknown" }
    case "idle": {
      // Its background work finished: the turn it ran after is over.
      if (phase === "background") return event.background ? delivery : ended(delivery)
      // After the turn's Stop, idle says nothing new; otherwise the turn ended without
      // one, keeping its counts for a Stop that arrives late.
      if (phase === "turn") return { ...counts(delivery), state: "unknown" }
      return delivery
    }
    case "input": {
      // Keys sent while a request waits answer it; they are no draft.
      if (event.answers) return delivery
      const change = {
        empty: false,
        // Only while a root turn runs does the harness queue what the person submits.
        submitted: delivery.submitted || (running(delivery) && event.submits),
      }
      if (delivery.state === "settled") return { ...counts(delivery), ...change, state: "drafting" }
      return { ...delivery, ...change }
    }
  }
}

/**
 * Whether a root Stop's hook may continue the turn with messages: the turn runs, the
 * person queued no prompt of their own during it, and NovaDeck has not yet continued it
 * as often as it may.
 */
export const continues = (delivery: Delivery): boolean =>
  stoppable(delivery) && !delivery.submitted && delivery.continued < maxContinuations

/**
 * When a message sent now would reach the agent, in the words `send` answers with. A
 * harness that sends nothing when a turn fails, as Codex, may only end its turn with its
 * next prompt.
 */
export const route = (delivery: Delivery, silentOnFailure: boolean): string => {
  switch (delivery.state) {
    case "fresh":
      return "when its agent first prompts"
    case "working":
      if (delivery.phase === "background") return "when its next turn starts"
      return silentOnFailure ? "at its turn's end or its next prompt" : "when its current turn ends"
    default:
      return "when the person next submits a prompt there"
  }
}
