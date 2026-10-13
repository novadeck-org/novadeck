// The offer whose notice came up in this run of the app, by its `updateKey`, and the run
// it came up in, as the host names it (`PortableState.run`). It lives in local storage,
// which every window of the app shares and a relaunch finds again, so the run it was
// written in tells whether it is this launch's: a stale portable copy's every-launch
// reminder comes once per launch, not once per page or per window, which macOS closes and
// opens again without ending the app. Without storage it is kept in memory, and a reload
// is a launch.
const updateRaisedStorageKey = "novadeck.update-raised"
type Raised = { readonly run: string; readonly key: string }
let raisedInMemory: Raised | null = null

const parse = (text: string | null): Raised | null => {
  try {
    const value: unknown = text === null ? null : JSON.parse(text)
    if (typeof value !== "object" || value === null) return null
    const { run, key } = value as Record<string, unknown>
    return typeof run === "string" && typeof key === "string" ? { run, key } : null
  } catch {
    return null
  }
}

/** The offer key whose notice was shown in `run`, if any was. */
export const readUpdateRaised = (run: string): string | null => {
  let raised: Raised | null
  try {
    raised = parse(localStorage.getItem(updateRaisedStorageKey))
  } catch {
    raised = raisedInMemory
  }
  return raised?.run === run ? raised.key : null
}

export const clearUpdateRaised = (): void => {
  raisedInMemory = null
  try {
    localStorage.removeItem(updateRaisedStorageKey)
  } catch {
    /* Nothing is kept. */
  }
}

/** Notes that the notice of the offer with this `key` was shown in `run`. */
export const writeUpdateRaised = (run: string, key: string): void => {
  try {
    localStorage.setItem(updateRaisedStorageKey, JSON.stringify({ run, key }))
  } catch {
    raisedInMemory = { run, key }
  }
}
