/**
 * A reason to write no notes: the model or `gh` failed, or its answer can't be trusted. It is
 * not an error of the run. The release keeps the body it has, and the run says why.
 */
export class Skip extends Error {
  /** The model's answer, when there was one, for a dry run to show. */
  readonly raw: string | undefined

  constructor(reason: string, raw?: string) {
    super(reason)
    this.raw = raw
  }
}

/** Awaits something read through `gh`, whose every failure is a reason to skip. */
export const viaGh = async <T>(what: string, read: Promise<T>): Promise<T> => {
  try {
    return await read
  } catch (error) {
    throw new Skip(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
