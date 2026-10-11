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
 * Working has three phases: a root `turn` running; `continuing`, after a Stop Novadeck
 * continued, until the continuation's first prompt; and `background`, when only work a
 * turn started still runs after its Stop: subagents (Claude Code's, Antigravity's, which
 * its Stop says only that something runs until its status line counts them), never a
 * command alone, which may run for ever. Only in a turn, or continuing, is the person's Enter a prompt their harness
 * queues; in the background it submits one at once. A turn keeps `turnAt`, as the
 * agent's activity does (`harnesses/activity.ts`), so an idle status line older than it
 * belongs to a turn already over.
 *
 * Whether the prompt is untouched (`box`) is decided here alone, from the person's keys
 * and the turns that follow them; nothing outside this module reckons it.
 */
export type Delivery = Counts &
  (
    | { readonly state: "unbound" | "fresh" | "drafting" }
    | {
        readonly state: "unknown"
        /**
         * When the hook of the idle status line that ended the turn started, where one did
         * (Antigravity's): a working one newer than it resumes the turn.
         */
        readonly idledAt?: number
        /** When the person's Escape that may have cancelled the turn came, where one did. */
        readonly escapedAt?: number
      }
    | { readonly state: "settled" | "ready"; readonly since: number }
    | {
        readonly state: "working"
        readonly phase: "turn"
        /**
         * When the hook of the turn's latest start or model call started, or of the idle
         * status line a working one resumed it after: an idle whose hook started before
         * it was drawn before the turn, and ends nothing.
         */
        readonly turnAt: number
      }
    | {
        readonly state: "working"
        readonly phase: "continuing"
        /** When the hook of the Stop Novadeck continued started, where it was told. */
        readonly stoppedAt?: number
      }
    | { readonly state: "working"; readonly phase: "background" }
    | {
        readonly state: "ringing"
        readonly nonce: string
        readonly touched: boolean
        /** Whether it rings a prompt shown with no session bound, which its own prompt binds. */
        readonly opening: boolean
      }
  )

/**
 * What Novadeck knows of the agent's input box, from the person's keys (see
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
  /** When the person's Enter that set `queuing` came; null when its time is unknown. */
  readonly queuingSince: number | null
  /**
   * When the person's last bare Enter came, outside a request, until a root prompt uses it
   * up; null once a key whose time is unknown came after it.
   */
  readonly enteredAt: number | null
  /**
   * When the person's first key after that Enter came, if one did: a prompt whose hook
   * started before it may still be theirs, one that started after it is not.
   */
  readonly typedAt: number | null
  /**
   * When the person's last Escape came, while their Enter waited for its prompt: one after
   * the prompt's hook started may have cancelled its turn, as no hook tells.
   */
  readonly escapedAt: number | null
  /** Whether the person typed since their last bare Enter: a draft of their own. */
  readonly typedSinceEnter: boolean
  /**
   * Whether Left, Home or End came, with no draft of the person's, while their Enter waited
   * for its prompt or a prompt they queued waited: no caret moved, so the harness may have
   * taken it as its own (Claude Code's Left opens its agents view). That prompt stays
   * theirs, but leaves no box known empty.
   */
  readonly strayed: boolean
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
  /** How many of the current turn's Stops Novadeck continued with messages. */
  readonly continued: number
  /**
   * Whether the person's own submission started the current root turn, as told below;
   * never a turn the doorbell or the harness started.
   */
  readonly byPerson: boolean
  readonly box: Box
}

export type DeliveryState = Delivery["state"]

/** Novadeck continues a root turn at most this often, by its own count, then lets it end. */
export const maxContinuations = 2

/**
 * How soon after the person's bare Enter a root turn's hook must start for the turn to be
 * their submission, on a platform. On Windows the hook's shell starts first (PowerShell
 * for Claude Code and Codex, cmd for Antigravity), which takes seconds on a busy machine:
 * on CI a prompt whose hook started past 2 s went without the messages waiting for it,
 * delivered at the turn's Stop instead (2026-10-10). The wider window there may take a
 * turn the agent starts by itself soon after a bare Enter as the person's.
 */
export const submitWindowFor = (platform: NodeJS.Platform): number =>
  platform === "win32" ? 20_000 : 2_000

/** How soon after the person's bare Enter a root turn must start to be their submission. */
export const submitWindowMs = submitWindowFor(process.platform)

/**
 * A key the person sent, as `terminals/keys.ts` tells it: a bare Enter, a harness's queue
 * key, one that never changes a draft (Left, Home, End: input wherever the person has no
 * draft of their own, as no caret moves there and what it does is the harness's own),
 * Escape, which never changes it either but may interrupt the agent's turn, one that may
 * take a prompt suggestion into an empty box (Right, Tab), or content.
 */
export type KeyKind = "enter" | "queue" | "neutral" | "escape" | "accept" | "content"

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
 *   prompt with its nonce, its hook started at `startedAt`;
 * - `stop`: a normal root Stop, which Novadeck `continued` or not, with work the turn
 *   started still running in the `background`;
 * - `ended`: a root turn ended abnormally: an Esc, a denial, a failure;
 * - either `recorded`: told by the session's own records where its hook's report never
 *   came, which ends only a turn still running or continuing, as the agent's activity
 *   took it (never the record of a Stop Novadeck continued), never one already ended;
 * - `idle`: the agent shows idle however its turn ended, with work still running in the
 *   `background` or not, as Antigravity's status line does, its hook started at `startedAt`;
 * - `working`: the agent shows working, as Antigravity's status line does, which resumes
 *   only a turn an older idle one ended;
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
      readonly startedAt: number
    }
  | {
      readonly type: "stop"
      readonly continued: boolean
      readonly background: boolean
      readonly at: number
      readonly recorded?: true
      /** When its hook started, where told. */
      readonly startedAt?: number
    }
  | { readonly type: "ended"; readonly recorded?: true }
  | {
      readonly type: "idle"
      readonly background: boolean
      readonly at: number
      readonly startedAt: number
    }
  | { readonly type: "working"; readonly startedAt: number }
  | { readonly type: "key"; readonly key: KeyKind; readonly asked: boolean; readonly at: number }
  | { readonly type: "asked-cleared" }
  | { readonly type: "ring"; readonly nonce: string; readonly opening: boolean }
  | { readonly type: "ring-failed"; readonly nonce: string }

/** A box nothing is known to be in: as a session binds. */
const emptyBox: Box = {
  empty: true,
  queuing: false,
  queuingSince: null,
  enteredAt: null,
  typedAt: null,
  escapedAt: null,
  typedSinceEnter: false,
  strayed: false,
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

/**
 * Whether a root turn may run: one running, or one an abnormal end may not have ended, as
 * an Escape that only closed a popup. What the person submits then, their harness may
 * queue.
 */
const mayRun = (delivery: Delivery): boolean => running(delivery) || delivery.state === "unknown"

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
  phase: "continuing" | "background",
  change: Partial<Counts> = {},
): Delivery => ({ ...counts(delivery), ...change, state: "working", phase })

/** A root turn running, as of the hook that started at `turnAt`. */
const turn = (delivery: Delivery, turnAt: number, change: Partial<Counts> = {}): Delivery => ({
  ...counts(delivery),
  ...change,
  state: "working",
  phase: "turn",
  turnAt,
})

/** The box after the person typed, outside a request: a draft, their Enter not alone. */
const typed = (box: Box): Box => ({
  ...box,
  empty: false,
  enteredAt: null,
  typedAt: null,
  typedSinceEnter: true,
  queued: false,
})

/**
 * What a new session there starts from: no turn yet, and the person's keys after their last
 * Enter, or a ring's line, as a draft, as keys typed once an agent's TUI reads input, before Novadeck has taken
 * its binding, reach its box (the probe's earlier ones were dropped). Any doubt is a draft.
 */
const arrived = (delivery: Delivery): Counts => {
  // A ring's line may be in the box too.
  const draft =
    delivery.box.typedSinceEnter ||
    delivery.box.strayed ||
    delivery.box.draftWhileAsked ||
    delivery.state === "ringing"
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
 * After an abnormal end, where the turn may have run on, an Enter just before the new
 * session is the command that replaced the old one: what it might have queued was the
 * old session's, now gone, as one Enter can't both queue a prompt and run a /clear.
 */
const atPrompt = (delivery: Delivery, at: number): Delivery => {
  const next = arrived(delivery)
  const { box } = delivery
  const entered = pendingEnter(delivery, at) !== undefined
  // Only when that Enter is the one that set `queuing`: one before it queued a prompt that
  // may stay.
  const queuing =
    box.queuing && !(delivery.state === "unknown" && entered && box.queuingSince === box.enteredAt)
  const kept = delivery.state !== "unbound" && (queuing || box.queued || (!box.empty && !entered))
  return next.box.typedSinceEnter || kept
    ? { ...next, box: typed(emptyBox), state: "drafting" }
    : { ...next, state: "ready", since: at }
}

/** The delivery after an event; the same delivery when it changes nothing. */
export const transition = (delivery: Delivery, event: DeliveryEvent): Delivery => {
  // Left, Home and End move a caret only through a draft the person typed since their last
  // Enter. Anywhere else the harness's box may be empty, even where Novadeck doesn't know
  // it so (a ring's line its Enter just submitted, the person's Enter whose hook hasn't
  // come, a prompt queued mid-turn), and what they do there is the harness's own (Claude
  // Code's Left opens its agents view, whose field would take a ring's line and its
  // Enter): input. One while the person's Enter or queued prompt waits keeps that prompt
  // theirs, but the box after it is a draft. In a request's dialog, it leaves a draft for
  // once the request clears, as one answered with no report has no dialog left.
  if (event.type === "key" && event.key === "neutral") {
    const { box } = delivery
    if (delivery.state === "unbound" || box.typedSinceEnter) return delivery
    if (event.asked) return asked(delivery)
    // Only an Enter still within its window can have a prompt to keep the person's: one
    // that started none is long past, and the key is input as anywhere else.
    if (pendingEnter(delivery, event.at) === undefined && !box.queuing && !box.queued)
      return keyed(delivery, false, event.at)
    return drafted(delivery, { ...box, empty: false, strayed: true })
  }
  // The person's Escape may interrupt a root turn, which no hook may tell (Claude Code's
  // before its first reply, which puts the prompt back in its box): Unknown, the box a
  // draft, keeping the counts and any queued prompt for the Stop that comes if it ended
  // nothing. With their Enter waiting for its prompt's hook, it is kept for that prompt,
  // which it may have cancelled; anywhere else it changes nothing.
  if (event.type === "key" && event.key === "escape") {
    if (running(delivery))
      return {
        ...counts(delivery),
        box: { ...typed(delivery.box), queuing: delivery.box.queuing },
        state: "unknown",
        escapedAt: event.at,
      }
    return delivery.box.enteredAt === null || delivery.state === "unbound"
      ? delivery
      : { ...delivery, box: { ...delivery.box, escapedAt: event.at } }
  }
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
        strayed: delivery.box.strayed,
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
    return submits
      ? { ...after, box: { ...after.box, draftWhileAsked: false, strayed: false } }
      : after
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
        return turn(delivery, event.startedAt, {
          epoch: delivery.epoch + 1,
          continued: 0,
          byPerson: false,
          box: { ...box, empty, queuing: false, enteredAt: null, typedAt: null, strayed: false },
        })
      }
      // A later model call of the running turn only moves its fence, as its activity's
      // does; nor does it end the wait for the continuation of a Stop Novadeck continued:
      // only the continuation's first call starts it.
      if (event.by === "call" && delivery.state === "working" && delivery.phase === "turn")
        return event.startedAt > delivery.turnAt
          ? { ...delivery, turnAt: event.startedAt }
          : delivery
      // A call during the continuation, after the continued Stop's hook started, as
      // Antigravity's past its first, is the continuation running: its turn, with its
      // counts, so an idle status line after it ends it. One from before is the old turn's.
      if (event.by === "call" && delivery.state === "working" && delivery.phase === "continuing")
        return delivery.stoppedAt !== undefined && event.startedAt > delivery.stoppedAt
          ? turn(delivery, event.startedAt)
          : delivery
      // The person's submission: their bare Enter shortly before its hook started, with
      // nothing typed before that, or a prompt they queued during the turn that just ended
      // and typed nothing after. Judged by when the hook started, not when it was heard,
      // as a loaded machine boots the hook late. A turn the harness started is never
      // theirs. Any doubt leaves a draft. Mid-ring the box holds the doorbell's line too:
      // no prompt empties it but its own.
      const person =
        event.by === "prompt" &&
        delivery.state !== "ringing" &&
        (pendingEnter(delivery, event.startedAt) !== undefined || box.queued)
      // Only a prompt uses up the person's Enter, or the prompt they queued. Keys after
      // its hook started are a new draft.
      const after: Box =
        event.by === "prompt"
          ? {
              ...box,
              enteredAt: null,
              typedAt: null,
              queued: false,
              strayed: false,
              ...(person && {
                empty: box.typedAt === null && !box.strayed,
                queuing: false,
                draftWhileAsked: false,
              }),
            }
          : box
      // A prompt right after a Stop Novadeck continued is that continuation: the same
      // turn, with its count, as Antigravity starts its model calls again from the first.
      if (phase === "continuing") return turn(delivery, event.startedAt, { box: after })
      // A call while no turn ran (as Antigravity's PreInvocation past the turn's first,
      // after its Stop or an idle status line) resumes the turn it belongs to, with its
      // counts, though nothing says the person started it.
      if (event.by === "call") return turn(delivery, event.startedAt, { byPerson: false })
      const started = turn(delivery, event.startedAt, {
        epoch: delivery.epoch + 1,
        continued: 0,
        byPerson: person,
        box: { ...after, queuing: false, escapedAt: null },
      })
      // The person's Escape after the Enter it answers and after its hook started may have
      // cancelled the turn before any other hook ran: Unknown, its prompt back in the box.
      const { enteredAt, escapedAt } = box
      const cancelled =
        event.by === "prompt" &&
        enteredAt !== null &&
        escapedAt !== null &&
        enteredAt <= event.startedAt &&
        enteredAt <= escapedAt &&
        event.startedAt < escapedAt
      return cancelled
        ? { ...counts(started), box: typed(started.box), state: "unknown", escapedAt }
        : started
    }
    case "stop": {
      if (event.recorded && phase !== "turn" && phase !== "continuing") return delivery
      if (!stoppable(delivery)) return delivery
      if (event.continued)
        return {
          ...working(delivery, "continuing", { continued: delivery.continued + 1 }),
          ...(event.startedAt !== undefined && { stoppedAt: event.startedAt }),
        }
      // A turn that ends with the person's queued prompt: its harness submits it next.
      const queued: Box = mayRun(delivery)
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
      if (event.recorded && phase !== "turn" && phase !== "continuing") return delivery
      // The turn's counts stay, as a Stop that raced this end is still that turn's.
      return { ...counts(delivery), state: "unknown" }
    case "idle": {
      // Its subagents finished, as an idle status line listing none running says: the
      // turn they ran after is over, a command it backgrounded (Antigravity's) left to run.
      if (phase === "background") return event.background ? delivery : ended(delivery, event.at)
      // After the turn's Stop, idle says nothing new, nor does one drawn before the turn
      // (its hook started before the turn's); otherwise the turn ended without one,
      // keeping its counts for a Stop that arrives late, or a working status line newer
      // than this one, which tells this one was stale.
      if (delivery.state !== "working" || delivery.phase !== "turn") return delivery
      if (event.startedAt < delivery.turnAt) return delivery
      return { ...counts(delivery), state: "unknown", idledAt: event.startedAt }
    }
    case "working":
      // The turn an older idle status line ended goes on, with its counts, fenced at that
      // idle. Never one a Stop ended: the status line can still say working just after it.
      return delivery.state === "unknown" &&
        delivery.idledAt !== undefined &&
        event.startedAt > delivery.idledAt
        ? turn(delivery, delivery.idledAt)
        : delivery
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
      // confirms nothing: a key that may change the box leaves a draft for later. Right
      // and Tab may too, as the request may have been answered with no report, its
      // dialog gone, and the prompt take a suggestion.
      if (event.asked)
        return event.key === "content" || event.key === "accept" ? asked(delivery) : delivery
      // A bare Enter on a box known empty (no draft typed while asked either) while a root
      // turn runs queues nothing in any harness: it answered something Novadeck didn't see
      // (a confirmation between two of Antigravity's status lines), or did nothing. At the
      // agent's prompt it keeps its meaning, as it may take a suggestion there.
      if (
        running(delivery) &&
        event.key === "enter" &&
        box.empty &&
        !box.queuing &&
        !box.draftWhileAsked
      )
        return delivery
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
 * When the person's bare Enter came, if a root turn whose hook started at `now` would be
 * their submission: within the window after it, and before any key they typed after it.
 * The one check of the window.
 */
export const pendingEnter = (delivery: Delivery, now: number): number | undefined => {
  const { enteredAt: at, typedAt } = delivery.box
  // An Enter after `now`, as one after a title judged as it came, submitted nothing then.
  if (at === null || at > now || now - at > submitWindowMs) return undefined
  return typedAt === null || typedAt > now ? at : undefined
}

/**
 * The delivery after a key, while a request waits on the person, that may change the box
 * should the request be stale, its dialog gone: a draft, applied once the request clears.
 */
const asked = (delivery: Delivery): Delivery =>
  delivery.box.draftWhileAsked
    ? delivery
    : { ...delivery, box: { ...delivery.box, draftWhileAsked: true } }

/** The delivery with the person's key changing the box to `box`: no longer ringable. */
const drafted = (delivery: Delivery, box: Box): Delivery => {
  if (delivery.state === "settled" || delivery.state === "ready")
    return { ...counts(delivery), box, state: "drafting" }
  if (delivery.state === "ringing") return { ...delivery, box, touched: true }
  return { ...delivery, box }
}

/** The delivery after the person's key outside a request: a bare Enter `submits`. */
const keyed = (delivery: Delivery, submits: boolean, at: number | null): Delivery => {
  const { box } = delivery
  const after: Box = {
    ...(submits && at !== null
      ? { ...box, enteredAt: at, typedAt: null, typedSinceEnter: false }
      : // A key after the Enter keeps it, timed, for a prompt whose hook started first.
        at !== null && box.enteredAt !== null
        ? { ...typed(box), enteredAt: box.enteredAt, typedAt: box.typedAt ?? at }
        : typed(box)),
    empty: false,
    // Only while a root turn runs, or may, does the harness queue what the person submits.
    queuing: box.queuing || (mayRun(delivery) && submits),
    queuingSince: box.queuing ? box.queuingSince : mayRun(delivery) && submits ? at : null,
  }
  return drafted(delivery, after)
}

/**
 * Whether a root Stop's hook may continue the turn with messages: the turn runs, the
 * person queued no prompt of their own during it, and Novadeck has not yet continued it
 * as often as it may.
 */
export const continues = (delivery: Delivery): boolean =>
  stoppable(delivery) && !delivery.box.queuing && delivery.continued < maxContinuations

/** The call of a running turn that a lead's message reaches its agent at, in `send`'s words. */
export type MidTurnCall = "tool call" | "model call"

/**
 * Where a lead's message reaches the harness's agent while its turn runs: at its next tool
 * call, or, where a hook asks before every model call (`reinjectPerCall`), its next model
 * call; undefined where it waits for the turn's end.
 */
export const midTurnCall = (
  hasToolHook: boolean,
  reinjectPerCall: boolean,
): MidTurnCall | undefined =>
  hasToolHook ? "tool call" : reinjectPerCall ? "model call" : undefined

/**
 * When a message sent now would reach the agent, in the words `send` answers with. A
 * harness that sends nothing when a turn fails, as Codex, may only end its turn with its
 * next prompt. The lead's message (`midTurn`, the call its harness delivers it at, where
 * it does) reaches a running turn at the agent's next such call instead.
 */
export const route = (
  delivery: Delivery,
  silentOnFailure: boolean,
  midTurn: MidTurnCall | undefined,
): string => {
  switch (delivery.state) {
    case "fresh":
      return "when its agent's first turn starts"
    case "ready":
    case "settled":
    case "ringing":
      return "ringing it now"
    case "working":
      if (delivery.phase === "background") return "when its next turn starts"
      if (midTurn) return `at its next ${midTurn}`
      return silentOnFailure ? "at its turn's end or its next prompt" : "when its current turn ends"
    default:
      return "when the user next submits a prompt there"
  }
}
