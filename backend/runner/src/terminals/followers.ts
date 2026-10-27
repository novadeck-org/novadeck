import { DomainError } from "../errors.js"

/** One stream to a client: the items sent to it, in order. */
export class Follower<T> {
  private readonly queue: T[] = []
  private finished = false
  private wake: (() => void) | undefined

  constructor(readonly owner: string) {}

  get open(): boolean {
    return !this.finished
  }

  push(item: T): void {
    if (this.finished) return
    this.queue.push(item)
    this.notify()
  }

  finish(): void {
    this.finished = true
    this.queue.length = 0
    this.notify()
  }

  async next(): Promise<T | undefined> {
    while (!this.finished && this.queue.length === 0)
      // eslint-disable-next-line no-await-in-loop -- Waits for the next item.
      await new Promise<void>((resolve) => (this.wake = resolve))
    return this.queue.shift()
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

/**
 * The clients following one kind of item the runner sends, oldest first: the newest
 * gets each item, and what was sent to a client that goes away is let go by whoever sent it.
 */
export class Followers<T> {
  private readonly followers: Follower<T>[] = []
  private finished = false

  /**
   * The items sent to `owner`'s client, until `signal` aborts, the owner is released, or
   * the runner shuts down. Once it ends, and `owner` follows on no other stream,
   * `abandon` hears of it.
   */
  async *follow(
    owner: string,
    abandon: (owner: string) => void,
    signal?: AbortSignal,
  ): AsyncGenerator<T> {
    if (this.finished) throw new DomainError("CLOSING")
    const follower = new Follower<T>(owner)
    this.followers.push(follower)
    const stop = () => follower.finish()
    signal?.addEventListener("abort", stop, { once: true })
    if (signal?.aborted) follower.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Items are delivered in order.
        const item = await follower.next()
        if (item === undefined) return
        yield item
      }
    } finally {
      signal?.removeEventListener("abort", stop)
      follower.finish()
      this.followers.splice(this.followers.indexOf(follower), 1)
      if (!this.follows(owner)) abandon(owner)
    }
  }

  /** The client that subscribed last, if any follows. */
  newest(): Follower<T> | undefined {
    return this.followers.findLast((each) => each.open)
  }

  /** Whether `owner` follows on a stream still open. */
  follows(owner: string): boolean {
    return this.followers.some((follower) => follower.owner === owner && follower.open)
  }

  /** Ends the owner's streams. */
  release(owner: string): void {
    for (const follower of this.followers) if (follower.owner === owner) follower.finish()
  }

  /** Ends every stream, as the runner shuts down. */
  finish(): void {
    this.finished = true
    for (const follower of this.followers) follower.finish()
  }
}
