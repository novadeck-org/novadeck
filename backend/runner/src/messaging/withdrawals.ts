import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { AgentName } from "@novadeck/protocol"

import { rootedIn, type Root } from "../harnesses/roots.js"
import { logs } from "../log.js"
import { running } from "./delivery.js"
import type { Live } from "./live.js"
import type { Sessions } from "./sessions.js"

const log = logs.for("messaging")

/**
 * What the person's own prompt starting a root turn does to the session's open asks: it
 * decides whether the turn counts, and takes the asks out only when the agent can be told.
 */
export type Person = {
  /** Whether the turn counts as the person's reply (never an opener's command-line prompt). */
  readonly counts: (turn: {
    readonly submittedAt: number
    readonly prompt: string | undefined
  }) => boolean
  /**
   * The session's open asks made before `before`, which the person's prompt would take out
   * (their entry ids), and the notice for the agent, if any; nothing changes yet.
   */
  readonly withdrawable: (
    before: number,
  ) => { readonly asks: readonly string[]; readonly notice: string } | undefined
  /** Withdraws those of `asks` still open, once the agent was told. */
  readonly withdraw: (asks: readonly string[]) => void
  /**
   * The notice of the asks the person dismissed from the Inbox since the agent's last hook,
   * for the session bound as `agent`'s `sessionId`; none for another session. It only rides
   * a hook answer: it wakes nothing.
   */
  readonly dismissed: (agent: AgentName, sessionId: string) => string | undefined
  /** Notes that the person's own prompt started a root turn at `at`, whether it counts or not. */
  readonly prompted: (at: number) => void
}

/** The asks a prompt of the person takes out of the Inbox, and the notice of it (`withdrawn`). */
export type Withdrawal = {
  readonly notice: string
  readonly asks: number
  readonly settle: () => void
}

/** The notices an answer carries (`notices`). */
export type Notices = { readonly texts: readonly string[]; readonly withdrawal?: Withdrawal }

/** What `personTurn` reads from before a report's turn events apply (see `before`). */
export type Before = { readonly epoch: number; readonly queuedAt: number | null | undefined }

/** A prompt as it is sent: line ends as `\n`, trimmed (see `Prompts` in `@novadeck/tui-input`). */
const sentText = (text: string): string => text.replace(/\r\n?/g, "\n").trim()

/** What withdrawals ask of the rest of messaging. */
export type WithdrawalsHost = {
  readonly sessions: Sessions
  /** Whether the runner closed messaging. */
  readonly closed: () => boolean
}

/**
 * What the person's own prompts do to the Inbox: the asks a prompt of theirs takes out,
 * told to the agent before they leave, and the fixed lines Inbox buttons send, which take
 * none out.
 */
export class Withdrawals {
  constructor(private readonly host: WithdrawalsHost) {}

  /**
   * Marks `text` as a fixed line an Inbox button is about to send the terminal's agent: the
   * turn it starts is the person's to delivery, but takes no open ask out of the Inbox. Each
   * send is its own entry, kept however long the line waits behind a running turn or the
   * person's own turns that come first, until a turn whose words are the line's (alone, or
   * folded with other marked lines) spends it, its send fails (`automaticFailed`, which
   * removes one entry) or the session ends.
   */
  automatic(terminalId: string, text: string): void {
    this.host.sessions.get(terminalId)?.automatic.push(sentText(text))
  }

  /** The send of a fixed line marked `automatic` failed: no turn will come of it. */
  automaticFailed(terminalId: string, text: string): void {
    const marks = this.host.sessions.get(terminalId)?.automatic
    const at = marks?.indexOf(sentText(text)) ?? -1
    if (at >= 0) marks!.splice(at, 1)
  }

  /**
   * What `personTurn` needs from before a report's turn events apply: the delivery epoch,
   * and, where the person queued a prompt during the turn that ended (the one the next turn
   * starts with), when they submitted it; null when that time is unknown.
   */
  before(live: Live): Before {
    const { epoch, box } = live.delivery
    return { epoch, queuedAt: box.queued ? box.queuingSince : undefined }
  }

  /**
   * Notes the root turn that `events` started, if it is the person's own submission as
   * delivery judges it (never a doorbell's or the harness's, nor an Inbox button's fixed
   * line), as owing a withdrawal of the asks made before it. They are taken out only with
   * the notice, by the next answer that can print it (`withdrawn`). It counts from when they
   * submitted: the turn's start, or, for a prompt they queued during the turn before, their
   * Enter, so what the agent asked in between is not taken for answered.
   */
  personTurn(
    live: Live,
    before: Before,
    events: readonly HarnessEvent[],
    person: Person | undefined,
  ): void {
    const { delivery, prompt } = live
    if (!person || delivery.epoch === before.epoch || !delivery.byPerson || !running(delivery))
      return
    const start = events.find(
      (event): event is Extract<HarnessEvent, { type: "turn-started" }> =>
        event.type === "turn-started" && event.cause === "prompt" && rootedIn(live.root, event),
    )
    if (!start) return
    person.prompted(start.startedAt)
    const text = prompt?.epoch === delivery.epoch ? prompt.text : undefined
    // A turn of Inbox lines alone spends their marks and withdraws nothing; the person's own
    // words spend none, and wait for the lines still to come.
    if (text !== undefined && this.spendAutomatic(live, text)) return
    // A queued prompt's time unknown: nothing says which asks it came after.
    if (before.queuedAt === null) return
    const submittedAt = Math.min(start.startedAt, before.queuedAt ?? start.startedAt)
    if (person.counts({ submittedAt, prompt: text }))
      live.withdrawing = { submittedAt, epoch: delivery.epoch }
  }

  /**
   * The notices an answer that can print them carries: the asks the person's prompt takes out
   * of the Inbox, then those they dismissed there (see `Person.dismissed`). `withdrawal` is
   * set when the first is among them.
   */
  notices(live: Live, root: Root, person: Person | undefined): Notices {
    const withdrawal = this.withdrawn(live, person)
    const dismissed = person?.dismissed(root.agent, root.sessionId)
    return {
      texts: [
        ...(withdrawal === undefined ? [] : [withdrawal.notice]),
        ...(dismissed === undefined ? [] : [dismissed]),
      ],
      ...(withdrawal && { withdrawal }),
    }
  }

  /**
   * Spends the marks `text` is made of, if it is entirely marked: one line, or several in
   * the order they were marked, joined by line breaks, as a harness folds lines queued close
   * together into one prompt. Whether it was; nothing is spent otherwise.
   */
  private spendAutomatic(live: Live, text: string): boolean {
    const marks = live.automatic
    const prompt = sentText(text)
    const one = marks.indexOf(prompt)
    if (one >= 0) {
      marks.splice(one, 1)
      return true
    }
    const taken: number[] = []
    let rest = prompt
    let from = 0
    while (rest !== "") {
      const next = marks.findIndex(
        (mark, at) => at >= from && (rest === mark || rest.startsWith(`${mark}\n`)),
      )
      if (next < 0) return false
      taken.push(next)
      rest = rest.slice(marks[next]!.length + 1)
      from = next + 1
    }
    for (const at of taken.toReversed()) marks.splice(at, 1)
    return taken.length > 0
  }

  /**
   * The notice of the asks the person's prompt takes out of the Inbox, when an answer that
   * can print it is due, those still open and made before their submission. They leave only
   * once the hook acknowledges having printed it (`settle`, run by the lease), so the agent
   * never loses an ask unheard; until then the prompt's debt stands, and a hook answering
   * before the acknowledgement may offer the notice again. Only within the turn the prompt
   * started: once it ended unpaid the debt is dropped and the asks stay open. None when no
   * prompt owes it.
   */
  private withdrawn(live: Live, person: Person | undefined): Withdrawal | undefined {
    const debt = live.withdrawing
    if (debt === null) return undefined
    const moved = debt.epoch !== live.delivery.epoch
    if (moved || !running(live.delivery)) {
      live.withdrawing = null
      log.info("messaging.withdrawal-dropped", "A prompt's withdrawal of asks was dropped.", {
        data: { terminalId: live.terminalId, reason: moved ? "turn-moved" : "turn-not-running" },
      })
      return undefined
    }
    // Once closed, no lease could carry the acknowledgement that withdraws them.
    if (!person || this.host.closed()) return undefined
    const found = person.withdrawable(debt.submittedAt)
    if (!found) {
      live.withdrawing = null
      return undefined
    }
    return {
      notice: found.notice,
      asks: found.asks.length,
      // A newer prompt's debt survives this one's late acknowledgement.
      settle: () => {
        if (live.withdrawing === debt) live.withdrawing = null
        person.withdraw(found.asks)
      },
    }
  }
}
