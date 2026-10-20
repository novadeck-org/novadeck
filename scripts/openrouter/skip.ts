/**
 * A reason to go on without the model's answer: the call or `gh` failed, or the answer can't
 * be trusted. It is not an error of the run: the caller keeps what it had, and says why.
 */
export class Skip extends Error {
  /** The model's answer, when there was one, for a dry run to show. */
  readonly raw: string | undefined

  constructor(reason: string, raw?: string) {
    super(reason)
    this.raw = raw
  }
}
