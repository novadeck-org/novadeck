import { Skip } from "../openrouter/skip.ts"

// A reason to write no notes: the release keeps the body it has, and the run says why.
export { Skip }

/** Awaits something read through `gh`, whose every failure is a reason to skip. */
export const viaGh = async <T>(what: string, read: Promise<T>): Promise<T> => {
  try {
    return await read
  } catch (error) {
    throw new Skip(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
