/** Per-test ownership, with every cleanup attempted even when an earlier one fails. */
export class Resources {
  private readonly cleanups: (() => void | Promise<void>)[] = []

  defer(cleanup: () => void | Promise<void>): void {
    this.cleanups.push(cleanup)
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = []
    for (const cleanup of this.cleanups.splice(0).toReversed()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Release dependents before their backing resources.
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Test resource cleanup failed")
  }
}
