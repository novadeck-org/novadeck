// A visitor's page can outlive a deploy of the static site, whose files carry new hashes: a
// lazily loaded part then fails to load and the app would stop. Reloading picks up the new
// build. A page that fails again right after its reload would only fail again, so a reload
// waits a minute after the last one, which the session keeps: a boot and the views it loads
// when idle fit well inside it, and a later deploy, or a part that failed for a moment, can
// still recover the page however long the tab stays open.
export const reloadKey = "novadeck:try-reloaded"
export const reloadGapMs = 60_000

export type ReloadStorage = Pick<Storage, "getItem" | "setItem">

/** Whether a page whose part failed to load reloads now; when it does, the time is kept. */
export const reloadsNow = (storage: ReloadStorage, now: number): boolean => {
  // An earlier build kept "1" here, which reads as long ago; a time ahead of now is a clock
  // that went back, so it doesn't hold a reload either.
  const kept = storage.getItem(reloadKey)
  const last = kept === null ? Number.NaN : Number(kept)
  if (Number.isFinite(last) && last <= now && now - last < reloadGapMs) return false
  storage.setItem(reloadKey, String(now))
  return true
}

/**
 * Reloads the page when one of its parts fails to load, as `reloadsNow` allows. A page whose
 * storage can't be reached, as a browser that blocks it, never reloads, since nothing would
 * stop it reloading again and again.
 */
export const reloadOnStaleDeploy = (
  page: EventTarget,
  storage: () => ReloadStorage,
  reload: () => void,
  now: () => number = Date.now,
): void => {
  page.addEventListener("vite:preloadError", (event) => {
    try {
      if (!reloadsNow(storage(), now())) return
    } catch {
      return
    }
    event.preventDefault()
    reload()
  })
}
