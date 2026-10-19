/** Whether a service is in the middle of something people are waiting on, and when that changes. */
export type Activity = {
  busy(): boolean
  /** Calls `listener` with each change of `busy`; returns an unsubscribe. */
  watch(listener: (busy: boolean) => void): () => void
}

/** An `Activity` over `probe`: whoever changes what it reads calls `update` afterwards. */
export class ActivityTracker implements Activity {
  private readonly listeners = new Set<(busy: boolean) => void>()
  private last = false

  constructor(private readonly probe: () => boolean) {}

  /** Whether busy now. Time can end a busy spell with no event, so asking also tells the listeners of that. */
  busy(): boolean {
    this.update()
    return this.last
  }

  watch(listener: (busy: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Tells the listeners if `busy` is not what it was when they last heard. */
  update(): void {
    const busy = this.probe()
    if (busy === this.last) return
    this.last = busy
    for (const listener of this.listeners) listener(busy)
  }
}
