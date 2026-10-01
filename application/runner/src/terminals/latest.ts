/**
 * A stream of snapshots that keeps only the newest unread one: a slow reader skips
 * those it missed, and one equal to the last delivered is not sent again.
 */
export class Latest<T> {
  private unread: { readonly value: T; readonly key: string } | undefined
  private delivered = ""
  private finished = false
  private wake: (() => void) | undefined

  /** `key` is the value as JSON, given where many readers take the same value. */
  push(value: T, key: string = JSON.stringify(value)): void {
    if (this.finished) return
    // Back to what the reader has: nothing new to read.
    this.unread = key === this.delivered ? undefined : { value, key }
    if (this.unread) this.notify()
  }

  /** Ends the stream, dropping anything not yet read. */
  finish(): void {
    this.finished = true
    this.unread = undefined
    this.notify()
  }

  async next(): Promise<T | undefined> {
    while (!this.finished && this.unread === undefined)
      // eslint-disable-next-line no-await-in-loop -- Waits for the next snapshot.
      await new Promise<void>((resolve) => (this.wake = resolve))
    const unread = this.unread
    this.unread = undefined
    if (unread) this.delivered = unread.key
    return unread?.value
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
