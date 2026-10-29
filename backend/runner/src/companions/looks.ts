import { randomUUID } from "node:crypto"

import type { PageLook, PageLookAnswer } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { Followers } from "../terminals/followers.js"

/**
 * How a look went: answered; sent to nobody, as no client follows; or left without an
 * answer, as its client went away or took too long.
 */
export type Looked =
  | { readonly type: "answered"; readonly answer: PageLookAnswer }
  | { readonly type: "nobody" | "gone" | "late" }

/**
 * Agents' looks at a page item, on their way to the client that shows the page. Each goes
 * to the client that subscribed last, which answers it with a picture, or says why it has
 * none. Looks work as an agent's requests for a terminal do (see `OpenRequests`).
 */
export class PageLooks {
  /** Each client's stream, oldest first. */
  private readonly followers = new Followers<PageLook>()
  /** Looks waiting for their answer, by id, with the client each went to. */
  private readonly pending = new Map<
    string,
    { readonly owner: string; readonly settle: (looked: Looked) => void }
  >()

  /**
   * The looks sent to `owner`'s client, until `signal` aborts, the owner is released, or
   * the runner shuts down. Those still waiting once it ends go without an answer.
   */
  follow(owner: string, signal?: AbortSignal): AsyncGenerator<PageLook> {
    return this.followers.follow(owner, (each) => this.abandon(each), signal)
  }

  /** Sends the look to the newest client and waits up to `ms` for its answer. */
  ask(look: Omit<PageLook, "lookId">, ms: number): Promise<Looked> {
    const follower = this.followers.newest()
    if (!follower) return Promise.resolve({ type: "nobody" })
    const lookId = randomUUID()
    return new Promise<Looked>((resolve) => {
      const timer = setTimeout(() => settle({ type: "late" }), ms)
      const settle = (looked: Looked) => {
        clearTimeout(timer)
        this.pending.delete(lookId)
        resolve(looked)
      }
      this.pending.set(lookId, { owner: follower.owner, settle })
      follower.push({ lookId, ...look })
    })
  }

  /** The client's answer; NOT_FOUND once nothing waits for it from this client. */
  answer(answer: PageLookAnswer, owner: string): void {
    const waiting = this.pending.get(answer.lookId)
    if (!waiting || waiting.owner !== owner) throw new DomainError("NOT_FOUND")
    waiting.settle({ type: "answered", answer })
  }

  /** Ends the owner's streams; what they still wait for goes without an answer. */
  release(owner: string): void {
    this.followers.release(owner)
    this.abandon(owner)
  }

  /** Ends every stream, as the runner shuts down. */
  finish(): void {
    this.followers.finish()
    for (const { settle } of this.pending.values()) settle({ type: "gone" })
  }

  /** Looks sent to `owner`, unless it still follows on another stream. */
  private abandon(owner: string): void {
    if (this.followers.follows(owner)) return
    for (const waiting of this.pending.values())
      if (waiting.owner === owner) waiting.settle({ type: "gone" })
  }
}
