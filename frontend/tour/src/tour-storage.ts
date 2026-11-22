// Where a run and its closing card are kept, in this window's session storage: a reload while the
// tour runs, or its closing card shows, follows them again, as their terminal survives the reload.
// Kept apart from the run's machinery, so a page can tell by these keys whether to load it.
export const storageKey = "novadeck.tour"
export const closingKey = "novadeck.tour.closing"

// Whether a run or a closing card was kept: the cheap check that decides whether the machinery
// loads at startup.
export const tourKept = (): boolean => {
  try {
    return (
      sessionStorage.getItem(storageKey) !== null || sessionStorage.getItem(closingKey) !== null
    )
  } catch {
    return false
  }
}
