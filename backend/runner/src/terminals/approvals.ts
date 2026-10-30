import { randomUUID } from "node:crypto"

import type { AgentName, Approval, ApprovalAction, ApprovalAnswer } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { Followers } from "./followers.js"

/** How an approval went: the person approved or declined it, or it ended with neither. */
export type ApprovalOutcome =
  /** The person approved it. */
  | "confirmed"
  /** The person declined it: things stay as they are. */
  | "declined"
  /** The client that was asked went away, or the runner stopped, before the person answered. */
  | "gone"
  /** Either terminal closed, so there is nothing left to approve. */
  | "withdrawn"

/** How a close of another terminal goes: at once, or once the person confirms. */
export type CloseWay = "now" | "ask"

/**
 * How an agent's close of another terminal goes: a teammate it leads, or a terminal that
 * runs no agent, closes at once; any other terminal that runs an agent closes only once
 * the person confirms.
 */
export const closeWay = (input: {
  /** Whether the caller is the target's running lead. */
  readonly leads: boolean
  /** The agent running in the target, if any. */
  readonly agent: AgentName | null
}): CloseWay => {
  return input.leads || input.agent === null ? "now" : "ask"
}

/**
 * Agents' asks to close a terminal that runs an agent they don't lead, or to lead one, on
 * their way to a client that approves them with the person. Each goes to the client that subscribed last
 * and waits, with no time limit, for the person's answer, until either terminal closes or
 * that client goes away. One waits at most for each terminal.
 */
export class Approvals {
  /** Each client's stream, oldest first. */
  private readonly followers = new Followers<Approval>()
  /** Asks waiting for the person, by id, with the client each went to. */
  private readonly pending = new Map<
    string,
    {
      readonly owner: string
      readonly from: string
      readonly terminalId: string
      readonly settle: (outcome: ApprovalOutcome) => void
    }
  >()

  /**
   * The asks sent to `owner`'s client, until `signal` aborts, the owner is released, or the
   * runner shuts down. Those still waiting once it ends are settled as `gone`.
   */
  follow(owner: string, signal?: AbortSignal): AsyncGenerator<Approval> {
    return this.followers.follow(owner, (each) => this.abandon(each), signal)
  }

  /** Why no ask can be made for `terminalId` now; undefined when one can. */
  refusal(terminalId: string): "nobody" | "waiting" | undefined {
    if ([...this.pending.values()].some((waiting) => waiting.terminalId === terminalId))
      return "waiting"
    return this.followers.newest() ? undefined : "nobody"
  }

  /**
   * Sends the newest client the ask for `from` to do `action` to `terminalId`, in
   * `sessionId`; `settled` hears how it went, once. Call `refusal` first: with no client, or one
   * already waiting for `terminalId`, nothing is sent and `settled` hears `gone`.
   */
  ask(
    ask: {
      readonly from: string
      readonly terminalId: string
      readonly sessionId: string
      readonly action: ApprovalAction
    },
    settled: (outcome: ApprovalOutcome) => void,
  ): void {
    const follower = this.followers.newest()
    if (!follower || this.refusal(ask.terminalId)) return settled("gone")
    const requestId = randomUUID()
    this.pending.set(requestId, {
      owner: follower.owner,
      from: ask.from,
      terminalId: ask.terminalId,
      settle: (outcome) => {
        this.pending.delete(requestId)
        // The client may still show it: take it back.
        if (outcome === "withdrawn" || outcome === "gone")
          follower.push({ type: "withdrawn", requestId })
        settled(outcome)
      },
    })
    follower.push({ type: "request", requestId, ...ask })
  }

  /** The client's answer; NOT_FOUND once nothing waits for it from this client. */
  answer(answer: ApprovalAnswer, owner: string): void {
    const waiting = this.pending.get(answer.requestId)
    if (!waiting || waiting.owner !== owner) throw new DomainError("NOT_FOUND")
    waiting.settle(answer.approved ? "confirmed" : "declined")
  }

  /** Takes back the asks that name `terminalId`, as the asker or the target, as it closes. */
  withdraw(terminalId: string): void {
    for (const waiting of this.pending.values())
      if (waiting.from === terminalId || waiting.terminalId === terminalId)
        waiting.settle("withdrawn")
  }

  /** Ends the owner's streams; what they still wait for is settled as `gone`. */
  release(owner: string): void {
    this.followers.release(owner)
    this.abandon(owner)
  }

  /** Ends every stream, as the runner shuts down. */
  finish(): void {
    this.followers.finish()
    for (const waiting of this.pending.values()) waiting.settle("gone")
  }

  /** Asks sent to `owner`, unless it still follows on another stream. */
  private abandon(owner: string): void {
    if (this.followers.follows(owner)) return
    for (const waiting of this.pending.values()) if (waiting.owner === owner) waiting.settle("gone")
  }
}
