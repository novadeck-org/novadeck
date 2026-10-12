// The offer whose notice came up in this run of the app, by its `updateKey`. It lives in
// session storage, which outlasts a page reload but not a relaunch, so a stale portable
// copy's every-launch reminder comes once per launch, not once per page. Without storage
// it is kept in memory, and a reload is a launch.
const updateRaisedStorageKey = "novadeck.update-raised"
let raisedInMemory: string | null = null
export const readUpdateRaised = (): string | null => {
  try {
    return sessionStorage.getItem(updateRaisedStorageKey) || null
  } catch {
    return raisedInMemory
  }
}

export const clearUpdateRaised = (): void => {
  raisedInMemory = null
  try {
    sessionStorage.removeItem(updateRaisedStorageKey)
  } catch {
    /* Nothing is kept. */
  }
}

export const writeUpdateRaised = (key: string): void => {
  try {
    sessionStorage.setItem(updateRaisedStorageKey, key)
  } catch {
    raisedInMemory = key
  }
}
