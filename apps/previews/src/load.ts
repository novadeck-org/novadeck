/**
 * One load for every call: calls at once share it, and a load that failed is started again by
 * the next call, so a one-off failure (a dev server restarted mid-import) isn't kept until the
 * page reloads.
 */
export const sharedLoad = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let loading: Promise<T> | undefined
  return () =>
    (loading ??= load().catch((error: unknown) => {
      loading = undefined
      throw error
    }))
}
