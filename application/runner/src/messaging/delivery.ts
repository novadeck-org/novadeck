/**
 * How a terminal's agent can take a message now, one state machine per terminal (see
 * docs/agent-messaging.md, "States"). Every terminal with an agent is in one state at
 * all times, derived from what its harness and its person did, so the prompt's emptiness
 * is known before any message arrives. A Settled terminal, or a Ready one (the agent's own
 * prompt shows, with no turn yet: a new session its harness announced there, or none yet
 * where the harness starts one only with the first prompt), is rung by the doorbell
 * (`terminals/doorbell.ts`) and is Ringing, with its ring's nonce, until a doorbell
 * prompt with that nonce confirms it or the ring fails; a Fresh (bound, but nothing
 * shows its prompt is up), Drafting (person busy) or Unknown one waits for its next root
 * prompt.
 *
 * Working has three phases: a root `turn` running; `continuing`, after a Stop NovaDeck
 * continued, until the continuation's first prompt; and `background`, when only work a
 * turn started still runs after its Stop (Claude Code's background tasks, Antigravity's
 * subagents). Only in a turn, or continuing, is the person's Enter a prompt their harness
 * queues; in the background it submits one at once.
 *
 * Whether the prompt is untouched (`box`) is decided here alone, from the person's keys
 * and the turns that follow them; nothing outside this module reckons it.
 */
export type Delivery = Counts &
  (
    | { readonly state: "unbound" | "fresh" | "drafting" | "unknown" }
    | { readonly state: "settled" | "ready"; readonly since: number }
    | { readonly state: "working"; readonly phase: "turn" | "continuing" | "background" }
    | {
        readonly state: "ringing"
        readonly nonce: string
        readonly touched: boolean
        /** Whether it rings a prompt shown with no session bound, which its own prompt binds. */
        readonly opening: boolean
      }
  )

/**
 * What NovaDeck knows of the agent's input box, from the person's keys (see
 * docs/agent-messaging.md, "What counts"). It errs toward a draft.
 */
export type Box = {
  /**
   * Whether the prompt is known empty: since the session bound (with nothing typed since
   * the Enter before it) or the person's last confirmed submission, they typed nothing
   * there.
   */
  readonly empty: boolean
  /** Whether the person submitted a prompt during the running turn, which their harness queues. */
  readonly queuing: boolean
  /** When the person's last bare Enter came, outside a request; null once they typed since. */
  readonly enteredAt: number | null
  /** Whether the person typed since their last bare Enter. */
  readonly typedSinceEnter: boolean
  /**
   * Whether the turn that last ended left a prompt the person queued during it, which the
   * harness submits next, with nothing typed after it.
   */
  readonly queued: boolean
  /**
   * Whether a key that may change the box came while a request waited on the person: a
   * draft, applied once the request clears, that only a confirmed submission undoes.
   */
  readonly draftWhileAsked: boolean
}

/** What every state carries. */
type Counts = {
  /**
   * Counts root turns and bindings, so what was leased in one turn never acts on a later
   * one, and a later call of a turn finds what its first was given.
   */
  readonly epoch: number
  /** How many of the current turn's Stops NovaDeck continued with messages. */
  readonly continued: number
  /**
   * Whether the person's own submission started the current root turn, as told below;
   * never a turn the doorbell or the harness started.
   */
  readonly byPerson: boolean
  readonly box: Box
}

export type DeliveryState = Delivery["state"]

/** NovaDeck continues a root turn at most this often, by its own count, then lets it end. */
export const maxContinuations = 2

/** How soon after the person's bare Enter a root turn must start to be their submission. */
export const submitWindowMs = 2_000

/**
 * A key the person sent, as `terminals/keys.ts` tells it: a bare Enter, a harness's queue
 * key, one that never changes the box (Escape, Left, Right, Home, End, Tab), or content.
 */
export type KeyKind = "enter" | "queue" | "neutral" | "content"

/**
 * What changes a terminal's delivery:
 * - `bound`: a session binds, or its harness announced a new one, `ready` when it
 *   announced it as its own input prompt came up, past its startup screens;
 * - `shown`: the agent's own empty prompt shows, past its startup screens, before the
 *   session it starts there binds (Codex, Antigravity): with no session bound, or
 *   `replaces` the one bound, as Codex's /clear starts a thread that binds only later;
 * - `unbound`: the binding ended, as its instance exited;
 * - `prompt`: a root turn started, as its decoder says: a `prompt` (the person's only if
 *   their bare Enter came shortly before with nothing typed since, or they queued it),
 *   one the `harness` started, a later model `call` of a running turn, or a `doorbell`
 *   prompt with its nonce;
 * - `stop`: a normal root Stop, which NovaDeck `continued` or not, with work the turn
 *   started still running in the `background`;
 * - `ended`: a root turn ended abnormally: an Esc, a denial, a failure;
 * - `idle`: the agent shows idle however its turn ended, with work still running in the
 *   `background` or not, as Antigravity's status line does;
 * - `key`: the person's key, while a request waits on them (`asked`) or not;
 * - `asked-cleared`: no request waits on the person any more;
 * - `ring`: the doorbell starts ringing a Settled terminal, with its nonce;
 * - `ring-failed`: that ring's test paste failed, or no doorbell prompt confirmed it.
 */
export type DeliveryEvent =
  | { readonly type: "bound"; readonly ready: boolean; readonly at: number }
  | { readonly type: "shown"; readonly at: number; readonly replaces: boolean }
  | { readonly type: "unbound" }
  | {
      readonly type: "prompt"
      readonly by: "prompt" | "harness" | "call" | "doorbell"
      readonly nonce?: string
      readonly at: number
    }
  | {
      readonly type: "stop"
      readonly continued: boolean
      readonly background: boolean
      readonly at: number
    }
  | { readonly type: "ended" }
  | { readonly type: "idle"; readonly background: boolean; readonly at: number }
  | { readonly type: "key"; readonly key: KeyKind; readonly asked: boolean; readonly at: number }
  | { readonly type: "asked-cleared" }
  | { readonly type: "ring"; readonly nonce: string; readonly opening: boolean }
  | { readonly type: "ring-failed"; readonly nonce: string }

/** A box nothing is known to be in: as a session binds. */
const emptyBox: Box = {
  empty: true,
  queuing: false,
  enteredAt: null,
  typedSinceEnter: false,
  queued: false,
  draftWhileAsked: false,
}

export const unbound: Delivery = {
  state: "unbound",
  epoch: 0,
  continued: 0,
  byPerson: false,
  box: { ...emptyBox, empty: false },
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
  delivery.state === "working" ||
  delivery.state === "unknown" ||
  delivery.state === "fresh" ||
  delivery.state === "ready"

/**
 * Since when the doorbell may ring the terminal, as far as its state goes: Settled since
 * its turn ended, Ready since its session bound; undefined in any other state.
 */
export const ringableSince = (delivery: Delivery): number | undefined =>
  delivery.state === "settled" || delivery.state === "ready" ? delivery.since : undefined

const counts = ({ epoch, continued, byPerson, box }: Delivery): Counts => ({
  epoch,
  continued,
  byPerson,
  box,
})

/** A turn ended normally: Settled with the prompt known empty, else the person drafting. */
const ended = (delivery: Delivery, at: number): Delivery => {
  const { box } = delivery
  const next = { ...counts(delivery), continued: 0, box: { ...box, queuing: false } }
  return box.empty && !box.queuing
    ? { ...next, state: "settled", since: at }
    : { ...next, state: "drafting" }
}

const working = (
  delivery: Delivery,
  phase: "turn" | "continuing" | "background",
  change: Partial<Counts> = {},
): Delivery => ({ ...counts(delivery), ...change, state: "working", phase })

/** The box after the person typed, outside a request: a draft, their Enter not alone. */
const typed = (box: Box): Box => ({
  ...box,
  empty: false,
  enteredAt: null,
  typedSinceEnter: true,
  queued: false,
})

/**
 * What a new session there starts from: no turn yet, and the person's keys after their last
 * Enter, or a ring's line, as a draft, as keys typed once an agent's TUI reads input, before NovaDeck has taken
 * its binding, reach its box (the probe's earlier ones were dropped). Any doubt is a draft.
 */
const arrived = (delivery: Delivery): Counts => {
  // A ring's line may be in the box too.
  const draft =
    delivery.box.typedSinceEnter || delivery.box.draftWhileAsked || delivery.state === "ringing"
  return {
    epoch: delivery.epoch + 1,
    continued: 0,
    byPerson: false,
    box: draft ? typed(emptyBox) : emptyBox,
  }
}

/**
 * A new session at the agent's own prompt, announced there or shown before it binds:
 * Ready, unless the box may hold the person's text. One that replaces a session bound here
 * (a /clear, an in-app resume) keeps that box, unless it was known empty or the person's
 * bare Enter just submitted it: an Enter that made a newline or took a suggestion left
 * their text there, and one during a turn queued a prompt the harness may still hold.
 */
const atPrompt = (delivery: Delivery, at: number): Delivery => {
  const next = arrived(delivery)
  const { box } = delivery
  const kept =
    delivery.state !== "unbound" &&
    (box.queuing || box.queued || (!box.empty && pendingEnter(delivery, at) === undefined))
  return next.box.typedSinceEnter || kept
    ? { ...next, box: typed(emptyBox), state: "drafting" }
    : { ...next, state: "ready", since: at }
}

/** The delivery after an event; the same delivery when it changes nothing. */
export const transition = (delivery: Delivery, event: DeliveryEvent): Delivery => {
  if (event.type === "bound") {
    // The session a ring's own prompt starts, where it rang a prompt shown before any
    // session bound (Codex's or Antigravity's first prompt binds one): the ring goes on,
    // for that prompt to confirm. Any other binding mid-ring takes its line as a draft.
    if (delivery.state === "ringing" && delivery.opening)
      return {
        ...arrived(delivery),
        box: delivery.box,
        state: "ringing",
        nonce: delivery.nonce,
        touched: delivery.touched,
        opening: false,
      }
    // Only a session announced at its own prompt may be rung before its first turn.
    if (!event.ready) return { ...arrived(delivery), state: "fresh" }
    return atPrompt(delivery, event.at)
  }
  // What the person typed after their last Enter outlasts the binding's end, which may be
  // noticed only as the next agent binds.
  if (event.type === "unbound")
    return {
      ...unbound,
      epoch: delivery.epoch + 1,
      box: {
        ...unbound.box,
        typedSinceEnter: delivery.box.typedSinceEnter,
        draftWhileAsked: delivery.box.draftWhileAsked,
      },
    }
  // The agent's prompt shows before any session binds: as a session announced at its
  // prompt would, from no session, or replacing the one bound.
  if (event.type === "shown")
    return delivery.state === "unbound" || event.replaces ? atPrompt(delivery, event.at) : delivery
  // With no agent bound, only whether the person typed after their last Enter counts, for
  // the session that binds next. Starting an agent takes an Enter, which clears it all.
  if (delivery.state === "unbound") {
    if (event.type !== "key" || event.asked) return delivery
    const submits = event.key === "enter" || event.key === "queue"
    const after = keyed(delivery, submits, event.at)
    return submits ? { ...after, box: { ...after.box, draftWhileAsked: false } } : after
  }
  const phase = phaseOf(delivery)
  const { box } = delivery
  switch (event.type) {
    case "prompt": {
      if (event.by === "doorbell") {
        // A ring's own prompt confirms it: the box held only its line, unless the person
        // typed while it rang. Another nonce's while ringing is no confirmation.
        if (delivery.state === "ringing" && event.nonce !== delivery.nonce)
          return transition(delivery, { ...event, by: "harness" })
        // Outside a ring it proves nothing of the box: a late hook of a failed ring, an
        // agent's first prompt after the person typed, or a stale line the person's Enter
        // submitted, which may have left text (a newline, a suggestion) in the box. Any
        // Enter of theirs is spent on it.
        const empty = delivery.state === "ringing" ? !delivery.touched : box.empty
        return working(delivery, "turn", {
          epoch: delivery.epoch + 1,
          continued: 0,
          byPerson: false,
          box: { ...box, empty, queuing: false, enteredAt: null },
        })
      }
      // A later call of the running turn changes nothing, nor ends the wait for the
      // continuation of a Stop NovaDeck continued: a status line saying working can come
      // before the continuation's first model call.
      if (event.by === "call" && (phase === "turn" || phase === "continuing")) return delivery
      // The person's submission: their bare Enter shortly before, with nothing typed
      // since, or a prompt they queued during the turn that just ended and typed nothing
      // after. A turn the harness started is never theirs. Any doubt leaves a draft.
      // Mid-ring the box holds the doorbell's line too: no prompt empties it but its own.
      const person =
        event.by === "prompt" &&
        delivery.state !== "ringing" &&
        (pendingEnter(delivery, event.at) !== undefined || box.queued)
      // Only a prompt uses up the person's Enter, or the prompt they queued.
      const after: Box =
        event.by === "prompt"
          ? {
              ...box,
              enteredAt: null,
              queued: false,
              ...(person && { empty: true, queuing: false, draftWhileAsked: false }),
            }
          : box
      // A prompt right after a Stop NovaDeck continued is that continuation: the same
      // turn, with its count, as Antigravity starts its model calls again from the first.
      if (phase === "continuing") return working(delivery, "turn", { box: after })
      // A call while no turn ran (as a status line saying working after an idle one)
      // resumes the turn it belongs to, with its counts, though nothing says the person
      // started it.
      if (event.by === "call") return working(delivery, "turn", { byPerson: false })
      return working(delivery, "turn", {
        epoch: delivery.epoch + 1,
        continued: 0,
        byPerson: person,
        box: { ...after, queuing: false },
      })
    }
    case "stop": {
      if (!stoppable(delivery)) return delivery
      if (event.continued)
        return working(delivery, "continuing", { continued: delivery.continued + 1 })
      // A turn that ends with the person's queued prompt: its harness submits it next.
      const queued: Box = running(delivery)
        ? { ...box, queued: box.queuing && !box.typedSinceEnter }
        : box
      // What the turn started still runs, and may start another turn by itself.
      if (event.background)
        return working(delivery, "background", {
          continued: 0,
          box: { ...queued, empty: box.empty && !box.queuing, queuing: false },
        })
      return ended({ ...delivery, box: queued }, event.at)
    }
    case "ended":
      // The turn's counts stay, as a Stop that raced this end is still that turn's.
      return { ...counts(delivery), state: "unknown" }
    case "idle": {
      // Its background work finished: the turn it ran after is over.
      if (phase === "background") return event.background ? delivery : ended(delivery, event.at)
      // After the turn's Stop, idle says nothing new; otherwise the turn ended without
      // one, keeping its counts for a Stop that arrives late.
      if (phase === "turn") return { ...counts(delivery), state: "unknown" }
      return delivery
    }
    case "ring":
      // Its line goes into the box: a draft, until its own prompt confirms it.
      return ringableSince(delivery) !== undefined
        ? {
            ...counts(delivery),
            box: { ...box, empty: false },
            state: "ringing",
            nonce: event.nonce,
            touched: false,
            opening: event.opening,
          }
        : delivery
    case "ring-failed":
      return delivery.state === "ringing" && delivery.nonce === event.nonce
        ? { ...counts(delivery), state: "unknown" }
        : delivery
    case "key": {
      // While a request waits on the person, no key is a submission, and a bare Enter
      // confirms nothing: a key that may change the box leaves a draft for later.
      if (event.asked)
        return event.key === "content" && !box.draftWhileAsked
          ? { ...delivery, box: { ...box, draftWhileAsked: true } }
          : delivery
      return keyed(delivery, event.key === "enter" || event.key === "queue", event.at)
    }
    case "asked-cleared":
      // What the person typed while it waited counts now, as typing outside a request.
      return box.draftWhileAsked
        ? keyed({ ...delivery, box: { ...box, draftWhileAsked: false } }, false, null)
        : delivery
  }
}

/**
 * When the person's bare Enter came, if a root turn starting `now` would be their
 * submission: within the window, with nothing typed since. The one check of the window.
 */
export const pendingEnter = (delivery: Delivery, now: number): number | undefined => {
  const at = delivery.box.enteredAt
  // An Enter after `now`, as one after a title judged as it came, submitted nothing then.
  return at !== null && at <= now && now - at <= submitWindowMs ? at : undefined
}

/** The delivery after the person's key outside a request: a bare Enter `submits`. */
const keyed = (delivery: Delivery, submits: boolean, at: number | null): Delivery => {
  const { box } = delivery
  const after: Box = {
    ...(submits && at !== null ? { ...box, enteredAt: at, typedSinceEnter: false } : typed(box)),
    empty: false,
    // Only while a root turn runs does the harness queue what the person submits.
    queuing: box.queuing || (running(delivery) && submits),
  }
  if (delivery.state === "settled" || delivery.state === "ready")
    return { ...counts(delivery), box: after, state: "drafting" }
  if (delivery.state === "ringing") return { ...delivery, box: after, touched: true }
  return { ...delivery, box: after }
}

/**
 * Whether a root Stop's hook may continue the turn with messages: the turn runs, the
 * person queued no prompt of their own during it, and NovaDeck has not yet continued it
 * as often as it may.
 */
export const continues = (delivery: Delivery): boolean =>
  stoppable(delivery) && !delivery.box.queuing && delivery.continued < maxContinuations

/**
 * When a message sent now would reach the agent, in the words `send` answers with. A
 * harness that sends nothing when a turn fails, as Codex, may only end its turn with its
 * next prompt.
 */
export const route = (delivery: Delivery, silentOnFailure: boolean): string => {
  switch (delivery.state) {
    case "fresh":
      return "when its agent's first turn starts"
    case "ready":
    case "settled":
    case "ringing":
      return "ringing it now"
    case "working":
      if (delivery.phase === "background") return "when its next turn starts"
      return silentOnFailure ? "at its turn's end or its next prompt" : "when its current turn ends"
    default:
      return "when the person next submits a prompt there"
  }
}
